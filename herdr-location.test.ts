import assert from "node:assert/strict";
import test from "node:test";
import { resolveHerdrLocations } from "./herdr-location.ts";
import { createHerdrClient, type HerdrClient, type HerdrResult } from "./project-agent.ts";
import type { SessionInfo } from "./types.ts";

function session(id: string, herdrPaneId?: string): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    ...(herdrPaneId ? { herdrPaneId } : {}),
  };
}

function snapshot(workspaceId: string, workspaceLabel: string, tabId: string, tabLabel: string, paneId = "pane-1"): unknown {
  return {
    snapshot: {
      panes: [
        { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, agent_session: { kind: "path", source: "herdr:pi", value: "/sessions/hosted.jsonl" } },
        { pane_id: "pane-2", tab_id: tabId, workspace_id: workspaceId },
      ],
      tabs: [{ tab_id: tabId, workspace_id: workspaceId, label: tabLabel }],
      workspaces: [{ workspace_id: workspaceId, label: workspaceLabel }],
    },
  };
}

function client(results: HerdrResult<unknown>[]): HerdrClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run<T>(args: string[]): Promise<HerdrResult<T>> {
      calls.push(args);
      return results.shift() as HerdrResult<T>;
    },
  };
}

test("does not invoke Herdr or change roster shape when every session is non-Herdr", async () => {
  const herdr = client([]);
  const inputs = [session("shell-a"), session("shell-b")];
  const resolved = await resolveHerdrLocations(inputs, { client: herdr });

  assert.strictEqual(resolved, inputs);
  assert.deepEqual(resolved, inputs);
  assert.deepEqual(herdr.calls, []);
  assert.equal(resolved.some((item) => "herdrLocation" in item), false);
});

test("resolves hosted and non-Herdr sessions from one current snapshot", async () => {
  const herdr = client([{ ok: true, data: snapshot("workspace-1", "Platform", "tab-1", "API") }]);
  const resolved = await resolveHerdrLocations([
    session("hosted", "pane-1"),
    session("second-hosted", "pane-2"),
    session("shell"),
  ], { client: herdr, now: () => 42 });

  assert.deepEqual(herdr.calls, [["api", "snapshot"]]);
  assert.deepEqual(resolved[0]!.herdrLocation, {
    status: "current",
    workspace: { id: "workspace-1", label: "Platform" },
    tab: { id: "tab-1", label: "API" },
    paneId: "pane-1",
    refreshedAt: 42,
  });
  assert.equal(resolved[1]!.herdrLocation?.status, "current");
  assert.deepEqual(resolved[2]!.herdrLocation, { status: "not_hosted" });
});

test("refreshes a moved pane instead of retaining its old tab or workspace", async () => {
  const herdr = client([
    { ok: true, data: snapshot("workspace-1", "Platform", "tab-1", "API", "pane-before") },
    { ok: true, data: snapshot("workspace-2", "Research", "tab-2", "Review", "pane-after") },
  ]);
  const hosted = session("hosted", "launch-pane");
  const sessionPaths = new Map([[hosted.id, "/sessions/hosted.jsonl"]]);

  const first = await resolveHerdrLocations([hosted], { client: herdr, now: () => 10, sessionPaths });
  const second = await resolveHerdrLocations([hosted], { client: herdr, now: () => 20, sessionPaths });

  assert.equal(first[0]!.herdrLocation?.status === "current" && first[0]!.herdrLocation.workspace.id, "workspace-1");
  assert.equal(first[0]!.herdrLocation?.status === "current" && first[0]!.herdrLocation.paneId, "pane-before");
  assert.equal(second[0]!.herdrLocation?.status === "current" && second[0]!.herdrLocation.workspace.id, "workspace-2");
  assert.equal(second[0]!.herdrLocation?.status === "current" && second[0]!.herdrLocation.tab.id, "tab-2");
  assert.equal(second[0]!.herdrLocation?.status === "current" && second[0]!.herdrLocation.paneId, "pane-after");
  assert.equal(herdr.calls.length, 2);
});

test("marks a registered pane missing from the live snapshot as unavailable", async () => {
  const herdr = client([{ ok: true, data: snapshot("workspace-1", "Platform", "tab-1", "API", "other-pane") }]);
  const [resolved] = await resolveHerdrLocations([session("stale", "gone-pane")], { client: herdr });

  assert.deepEqual(resolved!.herdrLocation, {
    status: "unavailable",
    paneId: "gone-pane",
    reason: "pane_missing",
    detail: "The hosted Pi session is absent from the current Herdr snapshot.",
  });
});

test("does not confidently choose between duplicate Pi session identities", async () => {
  const data = snapshot("workspace-1", "Platform", "tab-1", "API") as {
    snapshot: { panes: Array<Record<string, unknown>> };
  };
  data.snapshot.panes[1]!.agent_session = { kind: "path", source: "herdr:pi", value: "/sessions/hosted.jsonl" };
  const herdr = client([{ ok: true, data }]);
  const hosted = session("hosted", "launch-pane");
  const [resolved] = await resolveHerdrLocations([hosted], {
    client: herdr,
    sessionPaths: new Map([[hosted.id, "/sessions/hosted.jsonl"]]),
  });

  assert.deepEqual(resolved!.herdrLocation, {
    status: "unavailable",
    paneId: "launch-pane",
    reason: "invalid_response",
    detail: "Multiple Herdr panes advertise the same Pi session identity.",
  });
});

test("matches the live Herdr snapshot contract when running under Herdr", {
  skip: !process.env.HERDR_ENV || !process.env.HERDR_PANE_ID,
}, async () => {
  const paneId = process.env.HERDR_PANE_ID!;
  const liveClient = createHerdrClient();
  const initial = await liveClient.run<{ snapshot?: { panes?: Array<{ pane_id?: string; agent_session?: { kind?: string; source?: string; value?: string } }> } }>(["api", "snapshot"]);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (!initial.ok) return;
  const livePane = initial.data.snapshot?.panes?.find((pane) => pane.pane_id === paneId);
  const sessionPath = livePane?.agent_session?.kind === "path" && livePane.agent_session.source === "herdr:pi"
    ? livePane.agent_session.value
    : undefined;
  assert.ok(sessionPath, JSON.stringify(livePane));
  const liveSession = session("live", "obsolete-launch-alias");
  const [resolved] = await resolveHerdrLocations([liveSession], {
    client: liveClient,
    sessionPaths: new Map([[liveSession.id, sessionPath!]]),
  });
  assert.equal(resolved!.herdrLocation?.status, "current", JSON.stringify(resolved!.herdrLocation));
  if (resolved!.herdrLocation?.status === "current") {
    assert.ok(resolved.herdrLocation.workspace.id);
    assert.ok(resolved.herdrLocation.workspace.label);
    assert.ok(resolved.herdrLocation.tab.id);
    assert.ok(resolved.herdrLocation.tab.label);
  }
});

test("preserves list data and marks location unavailable when the Herdr command fails", async () => {
  const herdr = client([{ ok: false, error: { code: "HERDR_UNAVAILABLE", message: "missing binary" } }]);
  const inputs = [session("hosted", "pane-1"), session("shell")];
  const resolved = await resolveHerdrLocations(inputs, { client: herdr });

  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved[0]!.herdrLocation, {
    status: "unavailable",
    paneId: "pane-1",
    reason: "herdr_unavailable",
    detail: "missing binary",
  });
  assert.deepEqual(resolved[1]!.herdrLocation, { status: "not_hosted" });
});
