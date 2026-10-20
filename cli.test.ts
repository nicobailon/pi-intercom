import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_USAGE,
  DEFAULT_ASK_TIMEOUT_MS,
  parseCliArgs,
  buildCliRegistration,
  runCli,
  type CliClient,
} from "./cli.ts";
import { parseCrossMachineTarget } from "./cross-machine-discovery.ts";
import type { CrossMachineProvenance, Message, SessionInfo, SessionRegistration } from "./types.ts";

class MemorySink {
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join("");
  }
}

interface FakeClientOptions {
  sessions?: SessionInfo[];
  sendResult?: { id: string; delivered: boolean; reason?: string };
  replyOnSend?: { from: SessionInfo; text: string };
  unrelatedReplyOnSend?: boolean;
  sendError?: Error;
  connectError?: Error;
  listError?: Error;
}

class FakeClient implements CliClient {
  registrations: SessionRegistration[] = [];
  sends: Array<{ to: string; text: string; expectsReply?: boolean; crossMachine?: CrossMachineProvenance }> = [];
  disconnected = false;
  private readonly options: FakeClientOptions;
  private listeners: Array<(from: SessionInfo, message: Message) => void> = [];

  constructor(options: FakeClientOptions = {}) {
    this.options = options;
  }

  async connect(session: SessionRegistration): Promise<void> {
    this.registrations.push(session);
    if (this.options.connectError) throw this.options.connectError;
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (this.options.listError) throw this.options.listError;
    return this.options.sessions ?? [];
  }

  async send(to: string, options: { text: string; expectsReply?: boolean; crossMachine?: CrossMachineProvenance }): Promise<{ id: string; delivered: boolean; reason?: string }> {
    this.sends.push({ to, text: options.text, expectsReply: options.expectsReply, ...(options.crossMachine ? { crossMachine: options.crossMachine } : {}) });
    if (this.options.sendError) {
      throw this.options.sendError;
    }
    if (this.options.unrelatedReplyOnSend) {
      for (const listener of this.listeners) {
        listener(sessionFixture(), { id: "unrelated", timestamp: Date.now(), replyTo: "other-id", content: { text: "wrong reply" } });
      }
    }
    if (this.options.replyOnSend) {
      const reply: Message = {
        id: "reply-1",
        timestamp: Date.now(),
        replyTo: "sent-1",
        content: { text: this.options.replyOnSend.text },
      };
      for (const listener of this.listeners) {
        listener(this.options.replyOnSend.from, reply);
      }
    }
    return this.options.sendResult ?? { id: "sent-1", delivered: true };
  }

  on(_event: "message", listener: (from: SessionInfo, message: Message) => void): unknown {
    this.listeners.push(listener);
    return this;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function sessionFixture(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "0123456789abcdef",
    cwd: "/repo",
    model: "test-model",
    pid: 123,
    startedAt: 1,
    lastActivity: 2,
    name: "worker",
    ...overrides,
  };
}

test("parseCliArgs accepts list with defaults", () => {
  const opts = parseCliArgs(["list"]);
  assert.equal(opts.command, "list");
  assert.equal(opts.json, false);
  assert.equal(opts.timeoutMs, DEFAULT_ASK_TIMEOUT_MS);
  assert.equal(opts.name, "pi-intercom-cli");
});

test("parseCliArgs parses send options", () => {
  const opts = parseCliArgs(["send", "--to", "worker", "--text", "hello", "--name", "bridge", "--json"]);
  assert.deepEqual(
    { command: opts.command, to: opts.to, text: opts.text, name: opts.name, json: opts.json },
    { command: "send", to: "worker", text: "hello", name: "bridge", json: true },
  );
});

test("parseCliArgs parses ask timeout", () => {
  const opts = parseCliArgs(["ask", "--to", "worker", "--text", "?", "--timeout-ms", "5000"]);
  assert.equal(opts.timeoutMs, 5000);
});

test("parseCliArgs rejects unknown commands and options", () => {
  assert.throws(() => parseCliArgs([]), /unknown command/);
  assert.throws(() => parseCliArgs(["teleport"]), /unknown command/);
  assert.throws(() => parseCliArgs(["send", "--carrier-pigeon", "x"]), /unknown option/);
  assert.throws(() => parseCliArgs(["send", "--to"]), /missing value/);
});

test("parseCliArgs rejects invalid timeout values", () => {
  for (const value of ["0", "soon", "50garbage", "1.5", "-1", "9007199254740992"]) {
    assert.throws(() => parseCliArgs(["ask", "--to", "w", "--text", "?", "--timeout-ms", value]), /invalid --timeout-ms/);
  }
});

test("parseCliArgs requires --to and --text for send/ask", () => {
  assert.throws(() => parseCliArgs(["send", "--text", "hi"]), /--to is required/);
  assert.throws(() => parseCliArgs(["send", "--to", "w"]), /--text is required/);
  assert.throws(() => parseCliArgs(["ask", "--to", "w"]), /--text is required/);
  assert.throws(() => parseCliArgs(["send", "--to", "w", "--text-stdin", "ignored"]), /unknown option/);
});

test("parseCliArgs keeps relay hidden and restricted to an stdin envelope", () => {
  assert.doesNotMatch(CLI_USAGE, /relay/);
  assert.equal(parseCliArgs(["relay", "--envelope-stdin", "--json"]).envelopeStdin, true);
  for (const argv of [
    ["relay"],
    ["relay", "--envelope-stdin", "--text", "hello"],
    ["relay", "--envelope-stdin", "--text", ""],
    ["relay", "--envelope-stdin", "--name", "pi-intercom-cli"],
    ["relay", "--envelope-stdin", "--envelope-stdin"],
  ]) {
    assert.throws(() => parseCliArgs(argv), /relay requires only --envelope-stdin/);
  }
});

test("buildCliRegistration fills required session fields", () => {
  const registration = buildCliRegistration("bridge", 42);
  assert.equal(registration.name, "bridge");
  assert.equal(registration.model, "pi-intercom-cli");
  assert.equal(registration.startedAt, 42);
  assert.equal(registration.lastActivity, 42);
  assert.equal(typeof registration.cwd, "string");
  assert.equal(typeof registration.pid, "number");
});

test("runCli list prints roster rows", async () => {
  const client = new FakeClient({ sessions: [sessionFixture()] });
  const out = new MemorySink();
  const err = new MemorySink();
  const code = await runCli(["list"], { client, out, err });
  assert.equal(code, 0);
  assert.match(out.text(), /^worker\t01234567\ttest-model\t\?\t\/repo\n$/);
  assert.equal(err.text(), "");
  assert.equal(client.disconnected, true);
});

test("runCli list --json emits machine-readable roster", async () => {
  const client = new FakeClient({ sessions: [sessionFixture({ name: undefined })] });
  const out = new MemorySink();
  const code = await runCli(["list", "--json"], { client, out, err: new MemorySink() });
  assert.equal(code, 0);
  const result = JSON.parse(out.text()) as { ok: boolean; sessions: Array<{ name: string; id: string }> };
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].name, "(unnamed)");
  assert.equal(result.sessions[0].id, "0123456789abcdef");
});

test("runCli send reports delivery", async () => {
  const client = new FakeClient();
  const out = new MemorySink();
  const err = new MemorySink();
  const code = await runCli(["send", "--to", "worker", "--text", "build failed"], { client, out, err });
  assert.equal(code, 0);
  assert.match(out.text(), /^delivered to worker \(sent-1\)\n$/);
  assert.deepEqual(client.sends, [{ to: "worker", text: "build failed", expectsReply: undefined }]);
});

test("runCli send exits 1 on delivery failure", async () => {
  const client = new FakeClient({ sendResult: { id: "sent-1", delivered: false, reason: "Session not found" } });
  const out = new MemorySink();
  const err = new MemorySink();
  const code = await runCli(["send", "--to", "ghost", "--text", "hi"], { client, out, err });
  assert.equal(code, 1);
  assert.match(err.text(), /delivery failed: Session not found/);
});

test("runCli does not fall back to cross-machine send after local failure", async () => {
  const client = new FakeClient({ sendResult: { id: "sent-1", delivered: false, reason: "Session not found" } });
  const out = new MemorySink();
  const err = new MemorySink();
  let attempted = false;
  const code = await runCli(["send", "--to", "reviewer", "--text", "hello", "--name", "worker", "--json"], {
    client,
    out,
    err,
    crossMachineSend: async () => {
      attempted = true;
      throw new Error("should not run");
    },
  });
  assert.equal(code, 1);
  assert.equal(attempted, false);
  assert.match(JSON.parse(out.text()).error, /delivery failed: Session not found/);
});

test("runCli treats name@machine as an explicit remote address before local delivery", async () => {
  const client = new FakeClient();
  const code = await runCli(["send", "--to", "reviewer@workstation", "--text", "hello"], {
    client,
    out: new MemorySink(),
    err: new MemorySink(),
    crossMachineSend: async () => ({ machine: { label: "workstation", target: "workstation.example", enabled: true }, agent: { name: "reviewer" }, stdout: "" }),
  });
  assert.equal(code, 0);
  assert.equal(client.sends.length, 0);
});

test("runCli and discovery share the explicit remote address corpus", async () => {
  for (const target of ["reviewer@workstation", "00000000-0000-4000-8000-000000000001@workstation"]) {
    assert.doesNotThrow(() => parseCrossMachineTarget(target));
    const code = await runCli(["send", "--to", target, "--text", "hello"], {
      client: new FakeClient(),
      out: new MemorySink(),
      err: new MemorySink(),
      crossMachineSend: async () => ({ machine: { label: "workstation", target: "host", enabled: true }, agent: { name: "reviewer" }, stdout: "" }),
    });
    assert.equal(code, 0);
  }

  for (const target of ["@workstation", "reviewer@", "reviewer@@workstation", " reviewer@workstation", "reviewer@workstation ", "review er@workstation", "reviewer@work\tstation"]) {
    assert.throws(() => parseCrossMachineTarget(target), /expected name@machine or full-session-uuid@machine/);
    const client = new FakeClient();
    const code = await runCli(["send", "--to", target, "--text", "hello"], { client, out: new MemorySink(), err: new MemorySink() });
    assert.equal(code, 1);
    assert.equal(client.registrations.length, 0);
    assert.equal(client.sends.length, 0);
  }

  const client = new FakeClient();
  assert.equal(await runCli(["ask", "--to", "reviewer@workstation", "--text", "hello"], {
    client, out: new MemorySink(), err: new MemorySink(),
  }), 1);
  assert.equal(client.registrations.length, 0);
});

test("runCli relay registers an ephemeral asserted sender and forwards the envelope", async () => {
  const client = new FakeClient();
  const out = new MemorySink();
  const code = await runCli(["relay", "--envelope-stdin", "--json"], {
    client,
    out,
    err: new MemorySink(),
    readStdin: async () => JSON.stringify({ version: 1, target: "reviewer", text: "hello", trust: "ssh-asserted", origin: { name: "worker", sessionId: "00000000-0000-4000-8000-000000000001", machine: "laptop" } }),
  });
  assert.equal(code, 0);
  assert.equal(client.registrations[0]?.name, "worker@laptop");
  assert.equal(client.registrations[0]?.runtimeFallbackAlias, true);
  assert.equal(client.sends[0]?.to, "reviewer");
  assert.equal(client.sends[0]?.text, "[Unverified cross-machine origin]\nhello");
  assert.deepEqual(client.sends[0]?.crossMachine, {
    type: "ssh-relay",
    version: 1,
    origin: { name: "worker", sessionId: "00000000-0000-4000-8000-000000000001", machine: "laptop" },
    trust: "ssh-asserted",
  });
});

test("runCli relay cannot recurse to a remote address", async () => {
  const client = new FakeClient();
  const code = await runCli(["relay", "--envelope-stdin", "--json"], {
    client,
    out: new MemorySink(),
    err: new MemorySink(),
    readStdin: async () => JSON.stringify({ version: 1, target: "reviewer@workstation", text: "hello", trust: "ssh-asserted", origin: { name: "worker", sessionId: "session", machine: "laptop" } }),
  });
  assert.equal(code, 1);
  assert.equal(client.registrations.length, 0);
  assert.equal(client.sends.length, 0);
});

test("runCli ask prints the reply", async () => {
  const client = new FakeClient({ unrelatedReplyOnSend: true, replyOnSend: { from: sessionFixture(), text: "all good" } });
  const out = new MemorySink();
  const err = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "status?"], { client, out, err });
  assert.equal(code, 0);
  assert.equal(out.text(), "all good\n");
  assert.equal(client.sends[0]?.expectsReply, true);
});

test("runCli ask ignores unrelated replyTo and times out", async () => {
  const out = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "?", "--timeout-ms", "5", "--json"], {
    client: new FakeClient({ unrelatedReplyOnSend: true }), out, err: new MemorySink(),
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(out.text()).reason, "timeout");
});

test("runCli --json reports usage, connection, list, send, delivery and timeout failures", async () => {
  const cases: Array<{ argv: string[]; client: FakeClient; code: number; error: RegExp; reason?: string }> = [
    { argv: ["send", "--json"], client: new FakeClient(), code: 1, error: /--to is required/ },
    { argv: ["list", "--json"], client: new FakeClient({ connectError: new Error("offline") }), code: 1, error: /offline/ },
    { argv: ["list", "--json"], client: new FakeClient({ listError: new Error("broker rejected") }), code: 1, error: /broker rejected/ },
    { argv: ["send", "--to", "w", "--text", "hi", "--json"], client: new FakeClient({ sendError: new Error("broker rejected") }), code: 1, error: /broker rejected/ },
    { argv: ["send", "--to", "w", "--text", "hi", "--json"], client: new FakeClient({ sendResult: { id: "sent-1", delivered: false, reason: "not found" } }), code: 1, error: /not found/ },
    { argv: ["ask", "--to", "w", "--text", "?", "--timeout-ms", "5", "--json"], client: new FakeClient(), code: 2, error: /timed out/, reason: "timeout" },
  ];
  for (const { argv, client, code, error, reason } of cases) {
    const out = new MemorySink();
    const err = new MemorySink();
    assert.equal(await runCli(argv, { client, out, err }), code);
    assert.equal(err.text(), "");
    const lines = out.text().trim().split("\n");
    assert.equal(lines.length, 1);
    const body = JSON.parse(lines[0]) as { ok: boolean; error: string; reason?: string };
    assert.equal(body.ok, false);
    assert.match(body.error, error);
    assert.equal(body.reason, reason);
  }
});

test("runCli ask --json prints structured reply", async () => {
  const client = new FakeClient({ replyOnSend: { from: sessionFixture(), text: "yes" } });
  const out = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "?", "--json"], { client, out, err: new MemorySink() });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.text()), { ok: true, from: "worker", text: "yes" });
});

test("runCli ask exits 2 on timeout", async () => {
  const client = new FakeClient();
  const err = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "?", "--timeout-ms", "50"], { client, out: new MemorySink(), err });
  assert.equal(code, 2);
  assert.match(err.text(), /timed out after 50 ms/);
});

test("runCli ask exits 1 when delivery fails", async () => {
  const client = new FakeClient({ sendResult: { id: "sent-1", delivered: false, reason: "Session not found" } });
  const err = new MemorySink();
  const code = await runCli(["ask", "--to", "ghost", "--text", "?"], { client, out: new MemorySink(), err });
  assert.equal(code, 1);
  assert.match(err.text(), /delivery failed: Session not found/);
});

test("runCli ask exits 1 when the connection breaks during send", async () => {
  const client = new FakeClient({ sendError: new Error("Client disconnected") });
  const err = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "?", "--timeout-ms", "2000"], { client, out: new MemorySink(), err });
  assert.equal(code, 1);
  assert.match(err.text(), /delivery failed: Client disconnected/);
});

test("runCli exits 1 with usage text for bad arguments", async () => {
  const client = new FakeClient();
  const err = new MemorySink();
  const code = await runCli(["send"], { client, out: new MemorySink(), err });
  assert.equal(code, 1);
  assert.match(err.text(), new RegExp(CLI_USAGE.slice(0, 20)));
  assert.equal(client.registrations.length, 0);
});

test("packed artifact contains an executable pi-intercom bin and its runtime modules", () => {
  const temp = mkdtempSync(join(process.cwd(), ".pi-intercom-pack-"));
  const cache = join(temp, "npm-cache");
  const extracted = join(temp, "extracted");
  mkdirSync(cache);
  mkdirSync(extracted);
  try {
    const npmArgs = ["--ignore-scripts", "--cache", cache, "--json"];
    const dryRun = JSON.parse(execFileSync("npm", ["pack", "--dry-run", ...npmArgs], { encoding: "utf8" })) as Array<{ files: Array<{ path: string }> }> | Record<string, { files: Array<{ path: string }> }>;
    const dryRunPackage = Array.isArray(dryRun) ? dryRun[0]! : Object.values(dryRun)[0]!;
    const dryRunFiles = new Set(dryRunPackage.files.map((file) => file.path));
    for (const path of [
      "cli.mjs",
      "cli.ts",
      "cross-machine-discovery.ts",
      "cross-machine-envelope.ts",
      "cross-machine-transport.ts",
      "broker/client.ts",
      "package.json",
    ]) {
      assert.equal(dryRunFiles.has(path), true, `dry-run omitted ${path}`);
    }

    const packed = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", temp, ...npmArgs], { encoding: "utf8" })) as Array<{ filename: string }> | Record<string, { filename: string }>;
    const packedPackage = Array.isArray(packed) ? packed[0]! : Object.values(packed)[0]!;
    const tarball = join(temp, packedPackage.filename);
    const tarFiles = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
    assert.equal(tarFiles.includes("package/cli.mjs"), true);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted]);

    const packageRoot = join(extracted, "package");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin?: Record<string, string> };
    assert.equal(manifest.bin?.["pi-intercom"], "cli.mjs");
    const executable = join(packageRoot, "cli.mjs");
    assert.notEqual(statSync(executable).mode & 0o111, 0);
    const smoke = spawnSync(executable, [], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(smoke.status, 1);
    assert.match(smoke.stderr, /usage: pi-intercom/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
