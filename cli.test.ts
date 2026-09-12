import test from "node:test";
import assert from "node:assert/strict";
import {
  CLI_USAGE,
  DEFAULT_ASK_TIMEOUT_MS,
  parseCliArgs,
  buildCliRegistration,
  runCli,
  type CliClient,
} from "./cli.ts";
import type { Message, SessionInfo, SessionRegistration } from "./types.ts";

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
  sendError?: Error;
}

class FakeClient implements CliClient {
  registrations: SessionRegistration[] = [];
  sends: Array<{ to: string; text: string; expectsReply?: boolean }> = [];
  disconnected = false;
  private readonly options: FakeClientOptions;
  private listeners: Array<(from: SessionInfo, message: Message) => void> = [];

  constructor(options: FakeClientOptions = {}) {
    this.options = options;
  }

  async connect(session: SessionRegistration): Promise<void> {
    this.registrations.push(session);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.options.sessions ?? [];
  }

  async send(to: string, options: { text: string; expectsReply?: boolean }): Promise<{ id: string; delivered: boolean; reason?: string }> {
    this.sends.push({ to, text: options.text, expectsReply: options.expectsReply });
    if (this.options.sendError) {
      throw this.options.sendError;
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
  assert.throws(() => parseCliArgs(["ask", "--to", "w", "--text", "?", "--timeout-ms", "0"]), /invalid --timeout-ms/);
  assert.throws(() => parseCliArgs(["ask", "--to", "w", "--text", "?", "--timeout-ms", "soon"]), /invalid --timeout-ms/);
});

test("parseCliArgs requires --to and --text for send/ask", () => {
  assert.throws(() => parseCliArgs(["send", "--text", "hi"]), /--to is required/);
  assert.throws(() => parseCliArgs(["send", "--to", "w"]), /--text is required/);
  assert.throws(() => parseCliArgs(["ask", "--to", "w"]), /--text is required/);
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
  const rows = JSON.parse(out.text()) as Array<{ name: string; id: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "(unnamed)");
  assert.equal(rows[0].id, "0123456789abcdef");
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

test("runCli ask prints the reply", async () => {
  const client = new FakeClient({ replyOnSend: { from: sessionFixture(), text: "all good" } });
  const out = new MemorySink();
  const err = new MemorySink();
  const code = await runCli(["ask", "--to", "worker", "--text", "status?"], { client, out, err });
  assert.equal(code, 0);
  assert.equal(out.text(), "all good\n");
  assert.equal(client.sends[0]?.expectsReply, true);
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
