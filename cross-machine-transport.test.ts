import test from "node:test";
import assert from "node:assert/strict";
import { DISCOVERY_TIMEOUT_MS } from "./cross-machine-discovery.ts";
import {
  DELIVERY_TIMEOUT_MS,
  runCommand,
  sendCrossMachine,
  type CommandRunner,
} from "./cross-machine-transport.ts";

const fakeSessionId = "00000000-0000-4000-8000-000000000001";
const machines = JSON.stringify([{ label: "workstation", target: "workstation.example", enabled: true }]);
const agents = JSON.stringify({ id: "cli:agent:list", result: { agents: [{
  agent: "pi",
  name: "reviewer",
  agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: `/home/user/.pi/agent/sessions/session_${fakeSessionId}.jsonl` },
}] } });
const origin = { name: "worker", sessionId: fakeSessionId, machine: "laptop" };
const intercomList = JSON.stringify({ ok: true, sessions: [{ name: "host", id: fakeSessionId, model: "m", cwd: "/" }] });

function discoveryResult(command: string, args: string[]) {
  if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
  if (command === "herdr") return { code: 0, stdout: agents, stderr: "" };
  return undefined;
}

test("discovers only the selected machine and sends hostile message text only on stdin", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string; timeoutMs?: number }> = [];
  const run: CommandRunner = async (command, args, stdin, timeoutMs) => {
    calls.push({ command, args, stdin, timeoutMs });
    if (command === "herdr" && args[0] === "machine") {
      return { code: 0, stdout: JSON.stringify([
        { label: "laptop", target: "laptop.example", enabled: true },
        { label: "workstation", target: "workstation.example", enabled: true },
        { label: "disabled", target: "disabled.example", enabled: false },
      ]), stderr: "" };
    }
    if (command === "herdr") {
      return args[1] === "workstation" ? { code: 0, stdout: agents, stderr: "" } : { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
    }
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const hostileText = 'hello; $(touch /tmp/nope)\n"quoted" && exit 9';
  const result = await sendCrossMachine("reviewer@workstation", hostileText, origin, {
    run,
    herdrBin: "herdr",
    remoteCommand: "/opt/pi tools/pi-intercom --profile trusted",
  });
  assert.equal(result.machine.label, "workstation");
  assert.equal(calls.some((call) => call.args.includes("disabled")), false);
  const ssh = calls.at(-1)!;
  assert.equal(ssh.command, "ssh");
  assert.deepEqual(ssh.args, ["workstation.example", "/opt/pi tools/pi-intercom --profile trusted relay --envelope-stdin --json"]);
  assert.equal(ssh.args.some((arg) => arg.includes(hostileText)), false);
  assert.equal(JSON.parse(ssh.stdin!).text, hostileText);
  assert.equal(ssh.timeoutMs, DELIVERY_TIMEOUT_MS);
  assert.equal(calls.filter((call) => call.command === "herdr").every((call) => call.timeoutMs === DISCOVERY_TIMEOUT_MS), true);
});

test("delivers to a machine without Herdr over non-interactive SSH, addressed by session id", async () => {
  const sshCalls: Array<{ args: string[]; stdin?: string }> = [];
  const run: CommandRunner = async (command, args, stdin) => {
    if (command === "herdr") throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    sshCalls.push({ args, stdin });
    return { code: 0, stdout: args.at(-1)!.endsWith(" list --json") ? intercomList : '{"ok":true}', stderr: "" };
  };
  const result = await sendCrossMachine("host@buildbox", "hi", origin, { run, herdrBin: "herdr", remoteCommand: "pi-intercom" });
  assert.equal(result.machine.label, "buildbox");
  assert.deepEqual(sshCalls.at(-1)!.args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "buildbox", "pi-intercom relay --envelope-stdin --json"]);
  assert.equal(JSON.parse(sshCalls.at(-1)!.stdin!).target, fakeSessionId);
});

test("finds a Pi session outside a Herdr pane in a saved machine's intercom roster over the saved SSH target", async () => {
  const sshCalls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    if (command === "herdr") {
      return args[0] === "machine" ? { code: 0, stdout: machines, stderr: "" } : { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
    }
    sshCalls.push(args);
    return { code: 0, stdout: args.at(-1)!.endsWith(" list --json") ? intercomList : '{"ok":true}', stderr: "" };
  };
  const result = await sendCrossMachine("host@workstation", "hi", origin, { run, herdrBin: "herdr", remoteCommand: "pi-intercom" });
  assert.equal(result.machine.label, "workstation");
  assert.deepEqual(sshCalls, [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "workstation.example", "pi-intercom list --json"],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "workstation.example", "pi-intercom relay --envelope-stdin --json"],
  ]);
});

test("rejects empty or control-character remote commands before invoking SSH", async () => {
  for (const remoteCommand of ["", "   ", "pi-intercom\0--bad", "pi-intercom\t--bad", "pi-intercom\x1f--bad", "pi-intercom\x7f--bad"]) {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push(command);
      return discoveryResult(command, args) ?? { code: 0, stdout: '{"ok":true}', stderr: "" };
    };
    await assert.rejects(
      sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr", remoteCommand }),
      /Remote command must (not be empty|not contain ASCII control characters)/,
    );
    assert.equal(calls.includes("ssh"), false);
  }
});

test("runCommand returns an awaitable timeout result after terminating its child", async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], undefined, 30);
  assert.deepEqual(result, { stdout: "", stderr: "", code: 124, timedOut: true });
  assert.ok(Date.now() - started < 2_000, "timed-out child should be reaped promptly");
});

test("runCommand rejects once when spawning fails", async () => {
  await assert.rejects(runCommand("/definitely/not/a/command", [], undefined, 100), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("runCommand delivers all stdin to a reading child", async () => {
  const input = "hello π\n".repeat(32 * 1024);
  const result = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], input, 5_000);
  assert.deepEqual(result, { stdout: input, stderr: "", code: 0 });
});

test("runCommand preserves diagnostics when a failing child closes stdin early", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stdout.write('{"ok":false,"error":"relay unavailable"}');
    process.stderr.write("relay unavailable");
    process.exitCode = 7;
  `], "x".repeat(1024 * 1024), 5_000);
  assert.deepEqual(result, {
    stdout: '{"ok":false,"error":"relay unavailable"}',
    stderr: "relay unavailable",
    code: 7,
  });
});

test("runCommand rejects incomplete stdin even when the child exits successfully", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", 'require("node:fs").closeSync(0)'], "x".repeat(1024 * 1024), 5_000),
    /EPIPE|EOF|ECONNRESET|closed|destroyed/i,
  );
});

test("runCommand still reaps a child that closes stdin and then times out", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stderr.write("stdin closed");
    setTimeout(() => process.exit(8), 10_000);
  `], "x".repeat(1024 * 1024), 1_000);
  assert.deepEqual(result, { stdout: "", stderr: "stdin closed", code: 124, timedOut: true });
});

test("non-JSON and incompatible remote output report incompatible relay support", async () => {
  for (const stdout of ["", '{"ok":"yes"}', '{"version":2,"ok":true}']) {
    const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? { code: 1, stdout, stderr: "unknown command: relay" };
    await assert.rejects(
      sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr" }),
      /no compatible relay support and needs upgrading/,
    );
  }
});

test("structured remote failure preserves the reported error", async () => {
  const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: "target rejected the envelope version" }),
    stderr: "",
  };
  await assert.rejects(
    sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr" }),
    /Remote intercom delivery via workstation failed: target rejected the envelope version/,
  );
});


test("routing receipts use only the remote relay response and preserve unknown old remotes", async () => {
  const routing = { requested: fakeSessionId, resolved: { sessionId: fakeSessionId, endpointEpoch: "epoch", machine: "remote-owner" }, delivered: { sessionId: fakeSessionId, endpointEpoch: "epoch", machine: "remote-owner" } };
  for (const response of [{ ok: true }, { ok: true, id: "remote-msg", delivery: "socket_delivered", routing }, { ok: true, id: "queued-msg", delivery: "queued", routing: { requested: fakeSessionId, resolved: routing.resolved } }]) {
    const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? { code: 0, stdout: JSON.stringify(response), stderr: "" };
    const result = await sendCrossMachine("reviewer@workstation", "receipt", origin, { run });
    assert.deepEqual(result.routing, response.routing ? { ...response.routing, requested: "reviewer@workstation" } : undefined);
    assert.equal(result.id, response.id);
    assert.equal(result.delivery, response.delivery);
  }
  const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? { code: 0, stdout: JSON.stringify({ ok: true, routing: { requested: "x", delivered: { sessionId: 42 } } }), stderr: "" };
  await assert.rejects(sendCrossMachine("reviewer@workstation", "receipt", origin, { run }), /no compatible relay support/);
});
