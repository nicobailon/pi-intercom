import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openProjectPane,
  resolveTargetInCwd,
  waitForProjectSession,
  type HerdrClient,
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

test("openProjectPane opens a Herdr pane and runs pi in the project", async () => {
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
    const launched = await openProjectPane({ cwd: project, focus: false, client });

    assert.equal(launched.paneId, "pane-1");
    assert.equal(launched.herdrVersion, "herdr 0.7.5");
    assert.deepEqual(calls[1], ["pane", "split", "--current", "--direction", "right", "--cwd", launched.projectRoot]);
    assert.deepEqual(calls[2], ["pane", "run", "pane-1", "'pi'"]);
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
