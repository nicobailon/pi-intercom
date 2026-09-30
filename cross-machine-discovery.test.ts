import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_TIMEOUT_MS,
  discoverRemoteAgent,
  parseCrossMachineTarget,
  parseRemoteAgents,
  parseSavedMachines,
} from "./cross-machine-discovery.ts";
import type { CommandRunner } from "./cross-machine-transport.ts";

const fakeSessionId = "00000000-0000-4000-8000-000000000001";

function machineList(rows: Array<{ label: string; target: string; enabled: boolean }>): string {
  return JSON.stringify(rows);
}

function agentList(rows: Array<{ name: string; sessionId?: string }>): string {
  return JSON.stringify({ id: "cli:agent:list", result: { agents: rows.map((row) => ({
    agent: "pi",
    name: row.name,
    ...(row.sessionId ? {
      agent_session: {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: `/home/user/.pi/agent/sessions/session_${row.sessionId}.jsonl`,
      },
    } : {}),
  })) } });
}

const machines = machineList([
  { label: "laptop", target: "laptop.example", enabled: true },
  { label: "Workstation", target: "workstation.example", enabled: true },
  { label: "disabled", target: "disabled.example", enabled: false },
]);
const agents = agentList([{ name: "reviewer", sessionId: fakeSessionId }]);

test("parses the supported explicit remote address forms", () => {
  assert.deepEqual(parseCrossMachineTarget("reviewer@Workstation"), {
    agentTarget: "reviewer",
    machineLabel: "Workstation",
  });
  assert.deepEqual(parseCrossMachineTarget(`${fakeSessionId}@workstation`), {
    agentTarget: fakeSessionId,
    machineLabel: "workstation",
  });
});

test("parses current Herdr machine and agent list schemas", () => {
  assert.deepEqual(parseSavedMachines(machines), [
    { label: "laptop", target: "laptop.example", enabled: true },
    { label: "Workstation", target: "workstation.example", enabled: true },
    { label: "disabled", target: "disabled.example", enabled: false },
  ]);
  assert.deepEqual(parseRemoteAgents(agents), [{ name: "reviewer", sessionId: fakeSessionId }]);
});

test("unnamed remote Pi sessions are listed and targetable by session id", async () => {
  // Herdr omits `name` for panes that were never renamed.
  const unnamed = JSON.stringify({ result: { agents: [
    { agent: "pi", agent_session: { kind: "path", value: `/home/user/.pi/agent/sessions/x/2026_${fakeSessionId}.jsonl` } },
    { agent: "pi" },
  ] } });
  assert.deepEqual(parseRemoteAgents(unnamed), [{ name: fakeSessionId, sessionId: fakeSessionId }]);

  const run: CommandRunner = async (_command, args) => (
    args[0] === "machine" ? { code: 0, stdout: machines, stderr: "" } : { code: 0, stdout: unnamed, stderr: "" }
  );
  const match = await discoverRemoteAgent(`${fakeSessionId}@workstation`, { run, herdrBin: "herdr" });
  assert.equal(match.agent.sessionId, fakeSessionId);
});

test("explicit machine label restricts discovery to the unique known machine", async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const run: CommandRunner = async (_command, args, _stdin, timeoutMs) => {
    calls.push({ args, timeoutMs });
    if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
    return { code: 0, stdout: agents, stderr: "" };
  };

  const match = await discoverRemoteAgent("REVIEWER@workstation", { run, herdrBin: "herdr" });

  assert.equal(match.machine.label, "Workstation");
  assert.deepEqual(calls.map((call) => call.args), [
    ["machine", "list", "--json"],
    ["--machine", "Workstation", "agent", "list"],
  ]);
  assert.equal(calls.every((call) => call.timeoutMs === DISCOVERY_TIMEOUT_MS), true);
});

test("unknown and disabled machine labels fail before remote agent listing", async () => {
  for (const target of ["reviewer@unknown", "reviewer@disabled"]) {
    let remoteCalls = 0;
    const run: CommandRunner = async (_command, args) => {
      if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
      remoteCalls += 1;
      return { code: 0, stdout: agents, stderr: "" };
    };
    await assert.rejects(discoverRemoteAgent(target, { run, herdrBin: "herdr" }), /unknown or disabled/);
    assert.equal(remoteCalls, 0);
  }
});

test("malformed or non-explicit addresses fail closed without invoking Herdr", async () => {
  for (const target of [
    "reviewer",
    "@workstation",
    "reviewer@",
    "reviewer@@workstation",
    " reviewer@workstation",
    "reviewer@workstation ",
    "review er@workstation",
    "reviewer@work\tstation",
  ]) {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      return { code: 0, stdout: machines, stderr: "" };
    };
    await assert.rejects(discoverRemoteAgent(target, { run, herdrBin: "herdr" }), /expected name@machine or full-session-uuid@machine/);
    assert.equal(calls, 0);
  }
});

test("duplicate exact agent names on the selected machine are ambiguous", async () => {
  const run: CommandRunner = async (_command, args) => {
    if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
    return { code: 0, stdout: agentList([{ name: "reviewer" }, { name: "Reviewer" }]), stderr: "" };
  };
  await assert.rejects(
    discoverRemoteAgent("reviewer@workstation", { run, herdrBin: "herdr" }),
    /Multiple live Pi agents.*target is ambiguous/,
  );
});

test("full session UUID selects the exact remote agent", async () => {
  const otherSessionId = "00000000-0000-4000-8000-000000000002";
  const run: CommandRunner = async (_command, args) => {
    if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
    return {
      code: 0,
      stdout: agentList([
        { name: fakeSessionId, sessionId: otherSessionId },
        { name: "reviewer", sessionId: fakeSessionId },
      ]),
      stderr: "",
    };
  };
  const match = await discoverRemoteAgent(`${fakeSessionId}@workstation`, { run, herdrBin: "herdr" });
  assert.equal(match.agent.name, "reviewer");
  assert.equal(match.agent.sessionId, fakeSessionId);
});

test("timeout and command failures clearly identify the selected machine as unreachable", async () => {
  for (const failure of [
    { code: 124, stdout: "", stderr: "", timedOut: true },
    { code: 255, stdout: "", stderr: "connection refused" },
  ]) {
    const run: CommandRunner = async (_command, args) => {
      if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
      return failure;
    };
    await assert.rejects(
      discoverRemoteAgent("reviewer@workstation", { run, herdrBin: "herdr", discoveryTimeoutMs: 123 }),
      /machine "Workstation" is unreachable: (timed out|connection refused)/,
    );
  }
});

test("a reachable selected machine reports an exact-match miss", async () => {
  const run: CommandRunner = async (_command, args) => {
    if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
    return { code: 0, stdout: agentList([]), stderr: "" };
  };
  await assert.rejects(
    discoverRemoteAgent("missing@workstation", { run, herdrBin: "herdr" }),
    /No live Pi agent.*exactly matches "missing"/,
  );
});
