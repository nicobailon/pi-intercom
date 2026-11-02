import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  currentHerdrHost,
  openHerdrAppPane,
  openHerdrTuiPane,
  resolveTargetInCwd,
  waitForProjectSession,
  type HerdrClient,
  type HerdrResult,
} from "./project-agent.ts";
import type { SessionInfo } from "./types.ts";

function session(id: string, name: string | undefined, cwd: string): SessionInfo {
  return {
    id,
    ...(name ? { name } : {}),
    cwd,
    model: "test-model",
    pid: process.pid,
    startedAt: 1,
    lastActivity: 1,
  };
}

test("resolveTargetInCwd selects the sole peer in the requested cwd", () => {
  const resolved = resolveTargetInCwd({
    sessions: [
      session("self", "self", "/repo-a"),
      session("worker-a", "worker", "/repo-b"),
      session("worker-other", "worker", "/repo-c"),
    ],
    currentSessionId: "self",
    targetCwd: "/repo-b",
  });

  assert.equal(resolved.kind, "found");
  assert.equal(resolved.session?.id, "worker-a");
});

test("resolveTargetInCwd fails when a cwd has multiple possible peers and no target", () => {
  assert.throws(
    () => resolveTargetInCwd({
      sessions: [
        session("self", "self", "/repo-a"),
        session("worker-a", "worker-a", "/repo-b"),
        session("worker-b", "worker-b", "/repo-b"),
      ],
      currentSessionId: "self",
      targetCwd: "/repo-b",
    }),
    /Multiple intercom sessions are connected in \/repo-b/,
  );
});

test("resolveTargetInCwd scopes names to the requested cwd", () => {
  const resolved = resolveTargetInCwd({
    sessions: [
      session("self", "self", "/repo-a"),
      session("worker-a", "worker", "/repo-b"),
      session("worker-other", "worker", "/repo-c"),
    ],
    currentSessionId: "self",
    targetCwd: "/repo-b",
    to: "worker",
  });

  assert.equal(resolved.kind, "found");
  assert.equal(resolved.session?.id, "worker-a");
});

test("openHerdrTuiPane opens a Herdr pane and runs pi in the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-project-pane-"));
  const project = join(root, "project");
  mkdirSync(project);
  const calls: string[][] = [];
  const client: HerdrClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" };
      if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { id: "pane-1" } } };
      if (args[0] === "pane" && args[1] === "run") return { ok: true, data: {} };
      return { ok: false, error: { code: "VALIDATION_ERROR", message: `unexpected ${args.join(" ")}` } };
    },
  };

  try {
    const launched = await openHerdrTuiPane({ cwd: project, focus: false, client });

    assert.equal(launched.paneId, "pane-1");
    assert.deepEqual(calls[1], ["pane", "split", "--current", "--direction", "right", "--cwd", launched.projectRoot]);
    assert.deepEqual(calls[2], ["pane", "run", "pane-1", "pi"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentHerdrHost tells the Herdr TUI from the Herdr app, TUI first", () => {
  assert.deepEqual(currentHerdrHost({ HERDR_PANE_ID: "p1", HC_TERMINAL_ID: "t3" }), { kind: "tui", paneId: "p1" });
  assert.deepEqual(currentHerdrHost({ HC_TERMINAL_ID: "t3" }), { kind: "app", terminalId: "t3" });
  assert.equal(currentHerdrHost({}), undefined);
});

function recordingClient(reply: (args: string[]) => HerdrResult<unknown>): HerdrClient & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, async run<T>(args: string[]) { calls.push(args); return reply(args) as HerdrResult<T>; } };
}

test("openHerdrAppPane starts pi beside the caller's terminal and focuses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-app-pane-"));
  const hc = recordingClient((args) => args[0] === "get"
    ? { ok: true, data: { labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "api / 1" } } }
    : { ok: true, data: { address: "t9" } });
  // The window shows a new terminal shortly after hc run returns, so the first focus misses.
  const app = recordingClient(() => app.calls.length === 1
    ? { ok: false, error: { code: "VALIDATION_ERROR", message: "no such pane" } }
    : { ok: true, data: {} });

  try {
    const launched = await openHerdrAppPane({ cwd: root, terminalId: "t3", hc, app });

    assert.equal(launched.paneId, "t9");
    assert.deepEqual(hc.calls, [
      ["get", "t3", "--json"],
      ["run", "--bg", "--json", "--no-parent", "--keep", "--cwd", launched.projectRoot, "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--", "pi"],
    ]);
    assert.deepEqual(app.calls, [["do", "pane.focus", "--terminal", "t9"], ["do", "pane.focus", "--terminal", "t9"]]);

    app.calls.length = 0;
    await openHerdrAppPane({ cwd: root, terminalId: "t3", focus: false, hc, app });
    assert.deepEqual(app.calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each space: `folder` is where `ls` says it was made (stale on purpose), `cwd` where its first terminal's program runs now. */
function placementClients(spaces: Array<{ id: string; folder: string; cwd: string; machine?: string }>) {
  const hc = recordingClient((args) => {
    if (args[0] === "get" && args[1] === "t3") return { ok: true, data: { labels: { "herdr.space": "sp-caller", "herdr.tab": "tb-caller" } } };
    if (args[0] === "get") {
      const space = spaces.find((item) => `t-${item.id}` === args[1])!;
      return { ok: true, data: { cwd: space.folder, foreground: { cwd: space.cwd } } };
    }
    return { ok: true, data: { address: "t9" } };
  });
  const listed = spaces.map((space) => ({
    id: space.id,
    folder: space.folder,
    machine: space.machine ?? null,
    tabs: [{ id: `tb-${space.id}`, terminals: [{ terminal: `t-${space.id}`, pane: `p-${space.id}` }] }],
  }));
  const app = recordingClient((args) => args[0] === "ls"
    ? { ok: true, data: { spaces: listed } }
    : args[1] === "space.new" ? { ok: true, data: { space: "sp-new", tab: "tb-new", terminal: "t5" } } : { ok: true, data: {} });
  const run = () => hc.calls.find((args) => args[0] === "run");
  return { hc, app, run };
}

test("placement space keeps the pane beside the caller when its space is in this folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-placement-"));
  const { hc, app, run } = placementClients([{ id: "sp-caller", folder: "/made-elsewhere", cwd: root }]);
  try {
    await openHerdrAppPane({ cwd: root, terminalId: "t3", placement: "space", focus: false, hc, app });
    assert.ok(run()!.includes("herdr.tab=tb-caller"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("placement space opens a tab in the local space whose first terminal is in this folder, ignoring stale space folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-placement-"));
  const { hc, app, run } = placementClients([
    // Made in the target folder, but its terminal has moved on: must not match.
    { id: "sp-caller", folder: root, cwd: "/home" },
    { id: "sp-stale", folder: root, cwd: "/srv" },
    { id: "sp-remote", folder: "/x", cwd: root, machine: "vps" },
    { id: "sp-project", folder: "/home", cwd: root },
  ]);
  try {
    await openHerdrAppPane({ cwd: root, terminalId: "t3", placement: "space", focus: false, hc, app });
    assert.ok(run()!.includes("herdr.space=sp-project"));
    assert.ok(!run()!.some((arg) => arg.startsWith("herdr.tab=")));
    assert.ok(!hc.calls.some((args) => args[1] === "t-sp-remote"), "remote spaces are not inspected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("placement space creates a space named after the folder when no space is in it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-placement-"));
  const { hc, app, run } = placementClients([{ id: "sp-caller", folder: root, cwd: "/elsewhere" }]);
  try {
    const launched = await openHerdrAppPane({ cwd: root, terminalId: "t3", placement: "space", hc, app });
    assert.equal(launched.paneId, "t5");
    assert.equal(run(), undefined);
    const spaceNew = app.calls[1]!;
    assert.deepEqual(spaceNew.slice(0, 2), ["do", "space.new"]);
    assert.deepEqual(JSON.parse(spaceNew[2]!), { name: basename(launched.projectRoot), folder: launched.projectRoot, argv: ["sh", "-c", "pi"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("openHerdrAppPane refuses a caller terminal the window does not show", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-app-pane-"));
  const hc = recordingClient(() => ({ ok: true, data: { labels: {} } }));
  try {
    await assert.rejects(openHerdrAppPane({ cwd: root, terminalId: "t3", hc }), /not shown in the Herdr window/);
    assert.equal(hc.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitForProjectSession returns the new project-pane session when no target is named", async () => {
  const before = [session("self", "self", "/repo-a")];
  const after = [...before, session("pane-peer", "subagent-chat-pane", "/repo-b")];
  let calls = 0;
  const client = {
    async listSessions() {
      calls += 1;
      return calls === 1 ? before : after;
    },
  };

  const resolved = await waitForProjectSession(client, {
    projectRoot: "/repo-b",
    currentSessionId: "self",
    beforeSessionIds: new Set(before.map((item) => item.id)),
    pollMs: 1,
    timeoutMs: 100,
  });

  assert.equal(resolved.id, "pane-peer");
});

test("waitForProjectSession honors the target guard after opening a project pane", async () => {
  const before = [session("self", "self", "/repo-a")];
  const afterUnnamed = [...before, session("pane-peer", "subagent-chat-pane", "/repo-b")];
  const afterNamed = [...afterUnnamed, session("worker-id", "worker", "/repo-b")];
  let calls = 0;
  const client = {
    async listSessions() {
      calls += 1;
      if (calls === 1) return before;
      if (calls === 2) return afterUnnamed;
      return afterNamed;
    },
  };

  const resolved = await waitForProjectSession(client, {
    projectRoot: "/repo-b",
    currentSessionId: "self",
    beforeSessionIds: new Set(before.map((item) => item.id)),
    to: "worker",
    pollMs: 1,
    timeoutMs: 100,
  });

  assert.equal(resolved.id, "worker-id");
});
