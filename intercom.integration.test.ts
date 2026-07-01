import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReplyTracker } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

const repoDir = process.cwd();
const childEnvKeys = [
  "PI_SUBAGENT_ORCHESTRATOR_TARGET",
  "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
  "PI_INTERCOM_SESSION_ID",
  "PI_INTERCOM_NAME_POLL_MS",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_INTERCOM_SESSION_NAME",
] as const;
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-home-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
const { IntercomClient } = await import("./broker/client.ts");
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

async function waitForBrokerReady(broker: ChildProcessWithoutNullStreams): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      broker.stdout.off("data", onStdout);
      broker.off("exit", onExit);
    };

    broker.stdout.on("data", onStdout);
    broker.once("exit", onExit);
  });

  await ready;
}

async function withChildOrchestratorEnv<T>(metadata: {
  orchestratorTarget?: string;
  orchestratorSessionId?: string;
  inheritedIntercomSessionId?: string;
  namePollMs?: string;
  runId?: string;
  agent?: string;
  index?: string;
  sessionName?: string;
}, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of childEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  if (metadata.orchestratorTarget !== undefined) process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = metadata.orchestratorTarget;
  if (metadata.orchestratorSessionId !== undefined) process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = metadata.orchestratorSessionId;
  if (metadata.inheritedIntercomSessionId !== undefined) process.env.PI_INTERCOM_SESSION_ID = metadata.inheritedIntercomSessionId;
  if (metadata.namePollMs !== undefined) process.env.PI_INTERCOM_NAME_POLL_MS = metadata.namePollMs;
  if (metadata.runId !== undefined) process.env.PI_SUBAGENT_RUN_ID = metadata.runId;
  if (metadata.agent !== undefined) process.env.PI_SUBAGENT_CHILD_AGENT = metadata.agent;
  if (metadata.index !== undefined) process.env.PI_SUBAGENT_CHILD_INDEX = metadata.index;
  if (metadata.sessionName !== undefined) process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = metadata.sessionName;
  try {
    return await fn();
  } finally {
    for (const key of childEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface CapturedToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

interface RenderToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

interface RenderedComponent {
  render(width: number): string[];
}

interface RenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

interface CapturedTool {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<CapturedToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
  renderResult?: (result: RenderToolResult, options: { expanded?: boolean; isPartial?: boolean }, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
}

const renderTheme: RenderTheme = {
  fg: (_name, text) => text,
  bold: (text) => text,
};

function renderToText(component: RenderedComponent): string {
  return component.render(120).map((line) => line.trimEnd()).join("\n");
}

function createExtensionHarness(sessionName: string | (() => string) = "child-worker", options: {
  abort?: () => void;
  hasUI?: boolean;
  isIdle?: () => boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  ui?: unknown;
  sessionId?: string | (() => string);
} = {}) {
  const events = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: CapturedTool[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: { customType?: string; content?: string; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  const pi = {
    getSessionName: () => typeof sessionName === "function" ? sessionName() : sessionName,
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    registerMessageRenderer: () => undefined,
    registerTool: (tool: CapturedTool) => {
      tools.push(tool);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, command.handler);
    },
    registerShortcut: () => undefined,
    sendMessage: (message: { customType?: string; content?: string; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      sentMessages.push({ message, options });
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  };
  const ctx = {
    cwd: repoDir,
    mode: options.mode ?? (options.hasUI ? "tui" : "print"),
    model: { id: "child-model" },
    sessionManager: { getSessionId: () => typeof options.sessionId === "function" ? options.sessionId() : options.sessionId ?? "session-child-test" },
    isIdle: options.isIdle ?? (() => true),
    hasUI: options.hasUI ?? false,
    abort: options.abort ?? (() => undefined),
    ui: options.ui,
  };
  return {
    pi,
    ctx,
    tools,
    commands,
    entries,
    sentMessages,
    async emitLifecycle(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, eventContext);
      }
    },
    async emitLifecycleResults(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      const results = [];
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        results.push(await handler(payload, eventContext));
      }
      return results;
    },
  };
}

async function connectRawRegistered(sessionId: string, name: string, sessionOverrides: Record<string, unknown> = {}) {
  const net = await import("node:net");
  const { getBrokerSocketPath } = await import("./broker/paths.ts");
  const { createMessageReader, writeMessage } = await import("./broker/framing.ts");
  const socket = net.connect(getBrokerSocketPath());
  await once(socket, "connect");
  const registered = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Raw register timed out")), 2000);
    const reader = createMessageReader((msg) => {
      if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "registered") {
        clearTimeout(timeout);
        socket.off("data", reader);
        resolve();
      }
    }, reject);
    socket.on("data", reader);
  });
  writeMessage(socket, {
    type: "register",
    sessionId,
    session: {
      name,
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      ...sessionOverrides,
    },
  });
  await registered;
  return { socket, writeMessage };
}

test("opt-in TCP broker requires endpoint state for health and registration", { concurrency: false }, async () => {
  const net = await import("node:net");
  const { readFileSync } = await import("node:fs");
  const { createMessageReader, writeMessage } = await import("./broker/framing.ts");
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-tcp-agent-"));
  const broker = spawn("npx", [
    "--no-install",
    "tsx",
    "-e",
    "Object.defineProperty(process, 'platform', { value: 'win32' }); import('./broker/broker.ts').catch((error) => { console.error(error); process.exit(1); });",
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOME: agentDir,
      USERPROFILE: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_INTERCOM_TRANSPORT: "tcp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exchange = async (message: unknown, waitForResponse: boolean): Promise<unknown[]> => {
    const socket = net.connect({ host, port });
    const messages: unknown[] = [];
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("data", reader);
        socket.off("close", finish);
        socket.off("error", onSocketError);
        socket.destroy();
        resolve(messages);
      };
      const onSocketError = () => finish();
      const reader = createMessageReader((received) => {
        messages.push(received);
        if (waitForResponse) {
          finish();
        }
      }, reject);
      const timeout = setTimeout(finish, 500);
      socket.once("connect", () => writeMessage(socket, message));
      socket.on("data", reader);
      socket.once("close", finish);
      socket.once("error", onSocketError);
    });
  };

  let host = "";
  let port = 0;
  let stateId = "";
  try {
    await waitForBrokerReady(broker);
    const endpoint: unknown = JSON.parse(readFileSync(path.join(agentDir, "intercom", "broker.port.json"), "utf-8"));
    if (typeof endpoint !== "object" || endpoint === null || Array.isArray(endpoint)) {
      throw new Error("Invalid TCP endpoint fixture");
    }
    const endpointRecord = endpoint as Record<string, unknown>;
    if (endpointRecord.host !== "127.0.0.1" || typeof endpointRecord.port !== "number" || typeof endpointRecord.stateId !== "string") {
      throw new Error(`Invalid TCP endpoint fixture: ${JSON.stringify(endpointRecord)}`);
    }
    host = endpointRecord.host;
    port = endpointRecord.port;
    stateId = endpointRecord.stateId;

    assert.deepEqual(await exchange({ type: "health", requestId: "unauthorized-health" }, false), []);
    assert.deepEqual(await exchange({
      type: "register",
      sessionId: "unauthorized-tcp-client",
      session: {
        name: "unauthorized",
        cwd: repoDir,
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
    }, false), []);

    const healthMessages = await exchange({ type: "health", requestId: "authorized-health", stateId }, true);
    assert.deepEqual(healthMessages, [{
      type: "health_ok",
      requestId: "authorized-health",
      protocol: "pi-intercom",
      version: 1,
    }]);

    const registerMessages = await exchange({
      type: "register",
      sessionId: "authorized-tcp-client",
      stateId,
      session: {
        name: "authorized",
        cwd: repoDir,
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
    }, true);
    assert.deepEqual(registerMessages, [{ type: "registered", sessionId: "authorized-tcp-client" }]);
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
});

async function setupClients() {
  const broker = spawn("npx", ["--no-install", "tsx", path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForBrokerReady(broker);
    const planner = new IntercomClient();
    const orchestrator = new IntercomClient();

    await planner.connect({
      name: "planner",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    await orchestrator.connect({
      name: "orchestrator",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });

    return {
      planner,
      orchestrator,
      cleanup: async () => {
        await planner.disconnect().catch(() => undefined);
        await orchestrator.disconnect().catch(() => undefined);
        broker.kill("SIGTERM");
        await once(broker, "exit").catch(() => undefined);
      },
    };
  } catch (error) {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    throw error;
  }
}

function waitForReply(client: InstanceType<typeof IntercomClient>, replyTo: string, timeoutMs = 5000): Promise<{ from: SessionInfo; message: Message; }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", handler);
      reject(new Error(`Timed out waiting for reply to ${replyTo}`));
    }, timeoutMs);
    const handler = (from: SessionInfo, message: Message) => {
      if (message.replyTo !== replyTo) {
        return;
      }
      clearTimeout(timeout);
      client.off("message", handler);
      resolve({ from, message });
    };
    client.on("message", handler);
  });
}

async function waitForSessionByName(client: InstanceType<typeof IntercomClient>, name: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name}; saw ${JSON.stringify(sessions.map((session) => session.name))}`);
}

async function waitForSessionStatus(client: InstanceType<typeof IntercomClient>, name: string, status: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session?.status === status) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name} status ${status}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, status: session.status })))}`);
}

async function waitForSessionModel(client: InstanceType<typeof IntercomClient>, name: string, model: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session?.model === model) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name} model ${model}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, model: session.model })))}`);
}

async function waitForSessionId(client: InstanceType<typeof IntercomClient>, sessionId: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.id === sessionId);
    if (session) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${sessionId}; saw ${JSON.stringify(sessions.map((session) => session.id))}`);
}

async function waitForNoSessionId(client: InstanceType<typeof IntercomClient>, sessionId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!(await client.listSessions()).some((candidate) => candidate.id === sessionId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${sessionId} to leave`);
}

test("broker accepts caller supplied stable IDs across reconnect", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const worker = new IntercomClient();

  try {
    await worker.connect({
      name: "stable-worker",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    }, "stable-session-id");
    assert.equal(worker.sessionId, "stable-session-id");
    await waitForSessionId(planner, "stable-session-id");
    await worker.disconnect();
    await waitForNoSessionId(planner, "stable-session-id");

    const reconnected = new IntercomClient();
    await reconnected.connect({
      name: "stable-worker",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    }, "stable-session-id");
    assert.equal(reconnected.sessionId, "stable-session-id");
    await waitForSessionId(planner, "stable-session-id");
    await reconnected.disconnect();
  } finally {
    await worker.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("broker owns local trust metadata instead of trusting registration payloads", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const raw = await connectRawRegistered("trust-metadata-worker-id", "trust-metadata-worker", {
    peerUid: 0,
    trustedLocal: false,
  });

  try {
    const session = await waitForSessionId(planner, "trust-metadata-worker-id");
    assert.equal(session.trustedLocal, process.platform !== "win32");
    assert.equal(session.peerUid, undefined);
  } finally {
    raw.socket.destroy();
    await cleanup();
  }
});

test("broker rejects unknown replyTo values instead of delivering forged replies", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    const result = await planner.send(orchestrator.sessionId!, {
      text: "This is not a real reply.",
      replyTo: "not-a-pending-ask",
    });
    assert.equal(result.delivered, false);
    assert.match(result.reason ?? "", /pending ask/i);
  } finally {
    await cleanup();
  }
});

test("broker disconnects a connection that exceeds the local rate limit", { concurrency: false }, async () => {
  const { cleanup } = await setupClients();
  const raw = await connectRawRegistered("rate-limit-worker-id", "rate-limit-worker");

  try {
    raw.socket.on("error", () => undefined);
    const closed = once(raw.socket, "close");
    for (let i = 0; i < 300; i += 1) {
      raw.writeMessage(raw.socket, { type: "list", requestId: `flood-${i}` });
    }
    await closed;
    assert.equal(raw.socket.destroyed, true);
  } finally {
    raw.socket.destroy();
    await cleanup();
  }
});

test("broker idle raw connections cannot block legitimate registration", { concurrency: false }, async () => {
  const net = await import("node:net");
  const { getBrokerSocketPath } = await import("./broker/paths.ts");
  const { cleanup } = await setupClients();
  const sockets: ReturnType<typeof net.connect>[] = [];
  const legitimate = new IntercomClient();

  try {
    for (let i = 0; i < 140; i += 1) {
      const socket = net.connect(getBrokerSocketPath());
      socket.on("error", () => undefined);
      sockets.push(socket);
      await Promise.race([
        once(socket, "connect").catch(() => undefined),
        once(socket, "close").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
    }

    await legitimate.connect({
      name: "legitimate-after-idle-flood",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    assert.equal(legitimate.isConnected(), true);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await legitimate.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("broker times out sockets that unregister and go idle", { concurrency: false }, async () => {
  const { cleanup } = await setupClients();
  const raws: Array<Awaited<ReturnType<typeof connectRawRegistered>>> = [];
  const legitimate = new IntercomClient();

  try {
    for (let i = 0; i < 40; i += 1) {
      const raw = await connectRawRegistered(`unregister-idle-${i}`, `unregister-idle-${i}`);
      raw.socket.on("error", () => undefined);
      raw.writeMessage(raw.socket, { type: "unregister" });
      raws.push(raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await legitimate.connect({
      name: "legitimate-after-unregister-idle-flood",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    assert.equal(legitimate.isConnected(), true);
  } finally {
    for (const raw of raws) {
      raw.socket.destroy();
    }
    await legitimate.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("broker coalesces no-op presence floods", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const worker = new IntercomClient();
  const updates: SessionInfo[] = [];
  planner.on("presence_update", (session: SessionInfo) => {
    if (session.name === "presence-worker") {
      updates.push(session);
    }
  });

  try {
    await worker.connect({
      name: "presence-worker",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    worker.updatePresence({ status: "idle" });
    for (let i = 0; i < 20; i += 1) {
      worker.updatePresence({ status: "idle" });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(updates.length, 1);
  } finally {
    await worker.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("old stable-ID socket cannot mutate the replacement session", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const first = await connectRawRegistered("replaceable-session-id", "replaceable-worker-old");
  const replacement = new IntercomClient();

  try {
    await replacement.connect({
      name: "replaceable-worker-new",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    }, "replaceable-session-id");

    first.writeMessage(first.socket, { type: "presence", name: "stale-name" });
    first.writeMessage(first.socket, { type: "unregister" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacementSession = await waitForSessionId(planner, "replaceable-session-id");
    assert.equal(replacementSession.name, "replaceable-worker-new");

    const received = once(replacement, "message") as Promise<[SessionInfo, Message]>;
    const sent = await planner.send("replaceable-session-id", { text: "still there" });
    assert.equal(sent.delivered, true);
    const [, message] = await received;
    assert.equal(message.content.text, "still there");
  } finally {
    first.socket.destroy();
    await replacement.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("stable-ID replacement clears old ask edges and ignores stale cancels", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const first = await connectRawRegistered("replaceable-asker-id", "replaceable-asker-old");
  const replacement = new IntercomClient();

  try {
    first.writeMessage(first.socket, {
      type: "send",
      to: orchestrator.sessionId,
      message: { id: "old-ask-edge", timestamp: Date.now(), expectsReply: true, content: { text: "Old ask" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await replacement.connect({
      name: "replaceable-asker-new",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    }, "replaceable-asker-id");

    const reverseAfterReplace = await orchestrator.send("replaceable-asker-id", {
      messageId: "reverse-after-replace",
      text: "Can I ask the replacement?",
      expectsReply: true,
    });
    assert.equal(reverseAfterReplace.delivered, true);
    assert.equal((await replacement.send(orchestrator.sessionId!, {
      text: "Replacement answered.",
      replyTo: "reverse-after-replace",
    })).delivered, true);

    const replacementAsk = await replacement.send(orchestrator.sessionId!, {
      messageId: "replacement-ask-edge",
      text: "Replacement ask",
      expectsReply: true,
    });
    assert.equal(replacementAsk.delivered, true);
    first.writeMessage(first.socket, { type: "cancel_ask", messageId: "replacement-ask-edge" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reverseWhileReplacementWaits = await orchestrator.send("replaceable-asker-id", {
      messageId: "reverse-while-replacement-waits",
      text: "Can I ask while replacement waits?",
      expectsReply: true,
    });
    assert.equal(reverseWhileReplacementWaits.delivered, false);
    assert.match(reverseWhileReplacementWaits.reason ?? "", /Mutual ask refused/);
  } finally {
    first.socket.destroy();
    await replacement.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("broker resolves unique short IDs and rejects ambiguous prefixes", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const first = new IntercomClient();
  const second = new IntercomClient();
  const evilPrefix = new IntercomClient();

  try {
    await first.connect({ name: "short-id-one", cwd: repoDir, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "abcdef12-session");
    await second.connect({ name: "short-id-two", cwd: repoDir, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "abcdef99-session");
    await evilPrefix.connect({ name: "evil-prefix", cwd: repoDir, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "orchestrator-evil");

    const received = once(first, "message") as Promise<[SessionInfo, Message]>;
    const unique = await planner.send("abcdef12", { text: "prefix works" });
    assert.equal(unique.delivered, true);
    const [, message] = await received;
    assert.equal(message.content.text, "prefix works");

    const ambiguous = await planner.send("abcdef", { text: "ambiguous" });
    assert.equal(ambiguous.delivered, false);
    assert.match(ambiguous.reason ?? "", /Multiple sessions/);

    const exactNameReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const exactName = await planner.send("orchestrator", { text: "exact name wins" });
    assert.equal(exactName.delivered, true);
    const [, exactNameMessage] = await exactNameReceived;
    assert.equal(exactNameMessage.content.text, "exact name wins");
  } finally {
    await first.disconnect().catch(() => undefined);
    await second.disconnect().catch(() => undefined);
    await evilPrefix.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("intercom tool prefers exact names over ID prefixes", { concurrency: false }, async () => {
  const { orchestrator, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("./index.ts");
  const evilPrefix = new IntercomClient();
  const harness = createExtensionHarness("exact-name-worker");

  try {
    await evilPrefix.connect({ name: "evil-prefix", cwd: repoDir, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "orchestrator-evil");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const exactNameReceived = Promise.race([
      once(orchestrator, "message") as Promise<[SessionInfo, Message]>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    const result = await intercomTool.execute("send-exact-name", { action: "send", to: "orchestrator", message: "exact name wins" }, new AbortController().signal, undefined, harness.ctx);
    assert.notEqual(result.details?.error, true);

    const received = await exactNameReceived;
    assert.notEqual(received, null);
    assert.equal(received![1].content.text, "exact name wins");
    await harness.emitLifecycle("session_shutdown");
  } finally {
    await evilPrefix.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("intercom tool renders compact call and result rows", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness();

  piIntercomExtension(harness.pi as never);
  const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

  assert.ok(intercomTool.renderCall);
  assert.ok(intercomTool.renderResult);
  assert.match(renderToText(intercomTool.renderCall({
    action: "ask",
    to: "planner",
    message: "Need a decision before I continue with this implementation.",
    attachments: [{ type: "snippet", name: "note.ts", content: "const ok = true;" }],
  }, renderTheme, {})), /intercom ask → planner \(1 attachment\)\n  Need a decision/);

  const resultText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Message sent to planner" }],
    details: { delivered: true, messageId: "abcdef123456" },
  }, { isPartial: false, expanded: false }, renderTheme, { isError: false, expanded: false }));
  assert.match(resultText, /✓ Message sent to planner \(abcdef12\)/);

  const errorText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
    details: { error: true, reason: "Missing target" },
  }, { isPartial: false, expanded: true }, renderTheme, { isError: false, expanded: true }));
  assert.match(errorText, /✗ Missing 'to' or 'message' parameter/);
  assert.match(errorText, /Reason: Missing target/);
});

test("intercom tool result hook marks failed details as errors", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness();
  piIntercomExtension(harness.pi as never);

  const errorResults = await harness.emitLifecycleResults("tool_result", {
    toolName: "intercom",
    details: { error: true },
  });
  assert.deepEqual(errorResults.filter(Boolean), [{ isError: true }]);

  const deliveryResults = await harness.emitLifecycleResults("tool_result", {
    toolName: "contact_supervisor",
    details: { delivered: false },
  });
  assert.deepEqual(deliveryResults.filter(Boolean), [{ isError: true }]);

  const okResults = await harness.emitLifecycleResults("tool_result", {
    toolName: "intercom",
    details: { delivered: true },
  });
  assert.deepEqual(okResults.filter(Boolean), []);
});

test("contact supervisor tool renders reason and reply state", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

    assert.ok(supervisorTool.renderCall);
    assert.ok(supervisorTool.renderResult);
    assert.match(renderToText(supervisorTool.renderCall({
      reason: "interview_request",
      message: "Please answer these before I continue.",
      interview: { title: "API migration", questions: [] },
    }, renderTheme, {})), /contact_supervisor interview_request API migration\n  Please answer/);

    const warningText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Reply from supervisor:\nUse stable API" }],
      details: { structuredReplyParseError: "reply JSON must include a responses array" },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(warningText, /⚠ Reply from supervisor:\nUse stable API/);
    assert.match(warningText, /Structured reply parse issue: reply JSON must include a responses array/);

    const failureText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Invalid reason" }],
      details: { error: true },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(failureText, /✗ Invalid reason/);
  });
});

test("sessions publish automatic lifecycle status", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("status-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    await waitForSessionStatus(planner, "status-worker", "idle");

    const freshEventContext = {
      ...harness.ctx,
      model: { id: "fresh-model" },
      sessionManager: { getSessionId: () => "session-child-test" },
    };
    await harness.emitLifecycle("model_select", { model: { id: "fresh-model" } }, freshEventContext);
    await waitForSessionModel(planner, "status-worker", "fresh-model");

    await harness.emitLifecycle("agent_start");
    await waitForSessionStatus(planner, "status-worker", "thinking");

    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:bash");
    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-2", toolName: "read" });

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:read");

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-2", toolName: "read" });
    await waitForSessionStatus(planner, "status-worker", "thinking");

    await harness.emitLifecycle("agent_end");
    await waitForSessionStatus(planner, "status-worker", "idle");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("idle name poll propagates /name changes without other activity", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  let sessionName = "idle-name-before";
  const harness = createExtensionHarness(() => sessionName, { hasUI: true });

  try {
    await withChildOrchestratorEnv({ namePollMs: "25" }, async () => {
      const { default: piIntercomExtension } = await import("./index.ts");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, "idle-name-before");
      sessionName = "idle-name-after";
      await waitForSessionByName(planner, "idle-name-after");
    });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("turn_start re-registers when Pi replaces the session context", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  let sessionName = "fork-before";
  let sessionId = "session-fork-before";
  const harness = createExtensionHarness(() => sessionName, { hasUI: true, sessionId: () => sessionId });

  try {
    const { default: piIntercomExtension } = await import("./index.ts");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionId(planner, "session-fork-before");

    sessionName = "fork-after";
    sessionId = "session-fork-after";
    await harness.emitLifecycle("turn_start");
    const replaced = await waitForSessionId(planner, "session-fork-after");
    assert.equal(replaced.name, "fork-after");
    await waitForNoSessionId(planner, "session-fork-before");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("busy interactive sessions idle-gate top-level asks without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  let idle = false;
  const harness = createExtensionHarness("interactive-worker", {
    abort: () => { abortCount += 1; },
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "interactive-worker");

    const delivered = await planner.send(target.id, {
      messageId: "interactive-busy-ask",
      text: "Can you respond after your current turn?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
    assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Can you respond after your current turn/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("deferred startup connect is cancelled on shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("shutdown-before-start", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await harness.emitLifecycle("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessions = await planner.listSessions();
    assert.equal(sessions.some((session) => session.name === "shutdown-before-start"), false);
  } finally {
    await cleanup();
  }
});

test("stale overlay work stops after same-session restart", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let customCalls = 0;
  let resolveFirstCustom: ((value: unknown) => void) | undefined;
  const ui = {
    notify: () => undefined,
    custom: async () => {
      customCalls += 1;
      if (customCalls > 1) {
        return { sent: false };
      }
      return new Promise((resolve) => {
        resolveFirstCustom = resolve;
      });
    },
  };
  const harness = createExtensionHarness("overlay-worker", { hasUI: true, ui });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "overlay-worker");

    const overlayPromise = Promise.resolve(harness.commands.get("intercom")!("", harness.ctx));
    const deadline = Date.now() + 2000;
    while (!resolveFirstCustom && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(resolveFirstCustom, "overlay should reach the session picker");

    const plannerSession = await waitForSessionByName(planner, "planner");
    await harness.emitLifecycle("session_shutdown");
    await harness.emitLifecycle("session_start");
    resolveFirstCustom(plannerSession);
    await overlayPromise;

    assert.equal(customCalls, 1);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("queued inbound messages are discarded after shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("disposed-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "disposed-worker");

    const delivered = await planner.send(target.id, {
      messageId: "disposed-ask",
      text: "This should not deliver after shutdown.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.sentMessages.length, 0);

    await harness.emitLifecycle("session_shutdown");
    idle = true;
    await harness.emitLifecycle("agent_end");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await cleanup();
  }
});

test("busy non-interactive sessions auto-reply to top-level asks without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  const harness = createExtensionHarness("pipe-worker", {
    abort: () => { abortCount += 1; },
    hasUI: false,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "pipe-worker");

    const askId = "pipe-mode-ask";
    const replyPromise = waitForReply(planner, askId, 1000);
    const delivered = await planner.send(target.id, {
      messageId: askId,
      text: "Can you respond while busy?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const reply = await replyPromise;
    assert.equal(reply.message.replyTo, askId);
    assert.match(reply.message.content.text, /non-interactive|cannot respond/i);
    assert.equal(abortCount, 0);

  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("supervisor tool registers only when child metadata is present", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({}, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["intercom"]);
  });

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
    sessionName: "subagent-worker-78f659a3-1",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["contact_supervisor", "intercom"]);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor");
    assert.match(JSON.stringify(supervisorTool?.parameters), /interview_request/);
    assert.match(JSON.stringify(supervisorTool?.parameters), /questions/);
  });
});

test("child supervisor tool resolves target and includes run metadata", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");

      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const askReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const askResultPromise = supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which API should I use?" }, new AbortController().signal, undefined, harness.ctx);
      const [askFrom, askMessage] = await askReceived;
      assert.equal(askMessage.expectsReply, true);
      assert.match(askMessage.content.text, /Subagent needs a supervisor decision/);
      assert.match(askMessage.content.text, /Run: 78f659a3/);
      assert.match(askMessage.content.text, /Agent: worker/);
      assert.match(askMessage.content.text, /Child index: 0/);
      assert.match(askMessage.content.text, /Which API should I use\?/);

      const reply = await orchestrator.send(askFrom.id, { text: "Use the stable API.", replyTo: askMessage.id });
      assert.equal(reply.delivered, true);
      const askResult = await askResultPromise;
      assert.notEqual(askResult.details?.error, true);
      assert.match(askResult.content[0]?.text ?? "", /Use the stable API/);

      const updateReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Found a schema mismatch." }, new AbortController().signal, undefined, harness.ctx);
      const [_updateFrom, updateMessage] = await updateReceived;
      assert.equal(updateMessage.expectsReply, undefined);
      assert.match(updateMessage.content.text, /Subagent progress update/);
      assert.match(updateMessage.content.text, /Run: 78f659a3/);
      assert.match(updateMessage.content.text, /Agent: worker/);
      assert.match(updateMessage.content.text, /Found a schema mismatch/);
      assert.notEqual(updateResult.details?.error, true);

      const interviewReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const interview = {
        title: "API migration choices",
        description: "Choose the implementation path before edits continue.",
        questions: [
          { id: "context", type: "info", question: "Migration context", context: "Use the existing auth boundary." },
          { id: "api", type: "single", question: "Which API should I target?", options: [" Stable API ", "Experimental API"] },
          { id: "notes", type: "text", question: "Any constraints to preserve?" },
        ],
      };
      const interviewResultPromise = supervisorTool.execute("interview-1", {
        reason: "interview_request",
        message: "Please answer both so I can continue safely.",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [interviewFrom, interviewMessage] = await interviewReceived;
      assert.equal(interviewMessage.expectsReply, true);
      assert.match(interviewMessage.content.text, /Subagent requests a structured supervisor interview/);
      assert.match(interviewMessage.content.text, /Interview: API migration choices/);
      assert.match(interviewMessage.content.text, /\[context\] \(info\) Migration context/);
      assert.match(interviewMessage.content.text, /Info questions are context-only/);
      assert.match(interviewMessage.content.text, /\[api\] \(single\) Which API should I target\?/);
      assert.match(interviewMessage.content.text, /   - Stable API/);
      assert.match(interviewMessage.content.text, /\[notes\] \(text\) Any constraints to preserve\?/);
      assert.match(interviewMessage.content.text, /"responses"/);
      assert.doesNotMatch(interviewMessage.content.text, /"id": "context"/);

      const structuredReply = {
        responses: [
          { id: "api", value: "Stable API" },
          { id: "notes", value: "Keep the public error shape unchanged." },
        ],
      };
      const interviewReply = await orchestrator.send(interviewFrom.id, {
        text: `\`\`\`json\n${JSON.stringify(structuredReply, null, 2)}\n\`\`\``,
        replyTo: interviewMessage.id,
      });
      assert.equal(interviewReply.delivered, true);
      const interviewResult = await interviewResultPromise;
      assert.notEqual(interviewResult.details?.error, true);
      assert.match(interviewResult.content[0]?.text ?? "", /Stable API/);
      assert.deepEqual(interviewResult.details?.structuredReply, structuredReply);

      const invalidReplyReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const invalidReplyResultPromise = supervisorTool.execute("interview-invalid-reply", {
        reason: "interview_request",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [invalidReplyFrom, invalidReplyMessage] = await invalidReplyReceived;
      const invalidReply = await orchestrator.send(invalidReplyFrom.id, {
        text: '{"responses":[{"id":"api","value":"Removed API"}]}',
        replyTo: invalidReplyMessage.id,
      });
      assert.equal(invalidReply.delivered, true);
      const invalidReplyResult = await invalidReplyResultPromise;
      assert.notEqual(invalidReplyResult.details?.error, true);
      assert.equal(invalidReplyResult.details?.structuredReply, undefined);
      assert.match(String(invalidReplyResult.details?.structuredReplyParseError), /must match one of the question options/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool uses stable supervisor ID when names are duplicated", { concurrency: false }, async () => {
  const { orchestrator, cleanup } = await setupClients();
  const duplicate = new IntercomClient();

  try {
    await duplicate.connect({
      name: "orchestrator",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    }, "duplicate-orchestrator-id");

    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      orchestratorSessionId: orchestrator.sessionId!,
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const { default: piIntercomExtension } = await import("./index.ts");
      const harness = createExtensionHarness("duplicate-name-child");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const received = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const result = await supervisorTool.execute("update-duplicate", { reason: "progress_update", message: "Stable ID route." }, new AbortController().signal, undefined, harness.ctx);
      const [, message] = await received;
      assert.notEqual(result.details?.error, true);
      assert.match(message.content.text, /Stable ID route/);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await duplicate.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("child supervisor tool rejects invalid reasons and interview payloads", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, async () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
    const result = await supervisorTool.execute("invalid-1", { reason: "done", message: "Finished." }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(result.details?.error, true);
    assert.match(result.content[0]?.text ?? "", /Invalid reason/);

    const missingMessageResult = await supervisorTool.execute("invalid-message", { reason: "need_decision" }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(missingMessageResult.details?.error, true);
    assert.match(missingMessageResult.content[0]?.text ?? "", /Missing 'message'/);

    const invalidInterviewResult = await supervisorTool.execute("invalid-interview", { reason: "interview_request", interview: { title: "Bad" } }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInterviewResult.details?.error, true);
    assert.match(invalidInterviewResult.content[0]?.text ?? "", /interview\.questions must be a non-empty array/);

    const invalidInfoOptionsResult = await supervisorTool.execute("invalid-info-options", {
      reason: "interview_request",
      interview: {
        questions: [{ id: "context", type: "info", question: "Context", options: ["Not an answer"] }],
      },
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInfoOptionsResult.details?.error, true);
    assert.match(invalidInfoOptionsResult.content[0]?.text ?? "", /options is only valid for single and multi questions/);
  });
});

test("child supervisor tool preserves delivery failure reasons", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "missing-orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const harness = createExtensionHarness();
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(updateResult.details?.delivered, false);
      assert.match(updateResult.content[0]?.text ?? "", /Session not found/);
      assert.equal(updateResult.details?.reason, "Session not found");

      const askResult = await supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which path?" }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(askResult.details?.error, true);
      assert.match(askResult.content[0]?.text ?? "", /Session not found/);

      const secondAskResult = await supervisorTool.execute("ask-2", { reason: "need_decision", message: "Still blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(secondAskResult.details?.error, true);
      assert.match(secondAskResult.content[0]?.text ?? "", /Session not found/);
      assert.doesNotMatch(secondAskResult.content[0]?.text ?? "", /Already waiting/);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("regular intercom asks fail safely when started concurrently", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    const harness = createExtensionHarness("regular-ask-worker");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(orchestrator, "regular-ask-worker");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const firstMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const firstAsk = intercomTool.execute("ask-1", { action: "ask", to: "orchestrator", message: "First?" }, new AbortController().signal, undefined, harness.ctx);
    const secondAsk = intercomTool.execute("ask-2", { action: "ask", to: "orchestrator", message: "Second?" }, new AbortController().signal, undefined, harness.ctx);
    const [from, askMessage] = await firstMessage;
    assert.equal(askMessage.expectsReply, true);

    const earlyResults = await Promise.race([
      Promise.all([firstAsk, secondAsk]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    assert.equal(earlyResults, null);

    const pendingResult = await Promise.race([firstAsk, secondAsk]);
    assert.equal(pendingResult.details?.error, true);
    assert.match(pendingResult.content[0]?.text ?? "", /Already waiting/);

    const reply = await orchestrator.send(from.id, { text: "First answer.", replyTo: askMessage.id });
    assert.equal(reply.delivered, true);

    const results = await Promise.all([firstAsk, secondAsk]);
    assert.equal(results.filter((result) => result.details?.error === true).length, 1);
    assert.equal(results.filter((result) => /First answer/.test(result.content[0]?.text ?? "")).length, 1);
    await harness.emitLifecycle("session_shutdown");
  } finally {
    await cleanup();
  }
});

test("broker refuses reverse mutual asks until the original ask is answered", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
      messageId: "planner-to-orchestrator",
      text: "Can you decide?",
      expectsReply: true,
    });
    assert.equal(askToOrchestrator.delivered, true);

    const reverseAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "orchestrator-to-planner",
      text: "Can you decide instead?",
      expectsReply: true,
    });
    assert.equal(reverseAsk.delivered, false);
    assert.match(reverseAsk.reason ?? "", /Mutual ask refused/);

    const plainSend = await orchestrator.send(planner.sessionId!, { text: "Plain update still works." });
    assert.equal(plainSend.delivered, true);

    const reply = await orchestrator.send(planner.sessionId!, {
      text: "Answered.",
      replyTo: "planner-to-orchestrator",
    });
    assert.equal(reply.delivered, true);

    const nextAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "orchestrator-to-planner-after-reply",
      text: "Now can I ask?",
      expectsReply: true,
    });
    assert.equal(nextAsk.delivered, true);
  } finally {
    await cleanup();
  }
});

test("a reply can start a new reverse ask", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
      messageId: "planner-to-orchestrator-transition",
      text: "Can you decide?",
      expectsReply: true,
    });
    assert.equal(askToOrchestrator.delivered, true);

    const replyAndAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "orchestrator-reply-and-ask",
      text: "I answered; can you decide the next thing?",
      replyTo: "planner-to-orchestrator-transition",
      expectsReply: true,
    });
    assert.equal(replyAndAsk.delivered, true);

    const duplicateReverseAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "orchestrator-duplicate-reverse-ask",
      text: "Can I ask another before the first is answered?",
      expectsReply: true,
    });
    assert.equal(duplicateReverseAsk.delivered, true);

    const plannerReverseAsk = await planner.send(orchestrator.sessionId!, {
      messageId: "planner-reverse-while-orchestrator-waits",
      text: "Can I ask while you wait?",
      expectsReply: true,
    });
    assert.equal(plannerReverseAsk.delivered, false);
    assert.match(plannerReverseAsk.reason ?? "", /Mutual ask refused/);
  } finally {
    await cleanup();
  }
});

test("failed replies do not clear broker mutual-ask edges", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
      messageId: "planner-to-orchestrator-missing-reply",
      text: "Can you decide?",
      expectsReply: true,
    });
    assert.equal(askToOrchestrator.delivered, true);

    const missingReply = await orchestrator.send("missing-session", {
      messageId: "reply-to-missing-session",
      text: "Answered, maybe?",
      replyTo: "planner-to-orchestrator-missing-reply",
    });
    assert.equal(missingReply.delivered, false);
    assert.match(missingReply.reason ?? "", /Session not found/);

    const reverseAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "reverse-after-missing-reply",
      text: "Can I ask now?",
      expectsReply: true,
    });
    assert.equal(reverseAsk.delivered, false);
    assert.match(reverseAsk.reason ?? "", /Mutual ask refused/);

    const deliveredReply = await orchestrator.send(planner.sessionId!, {
      messageId: "reply-to-planner",
      text: "Actually answered.",
      replyTo: "planner-to-orchestrator-missing-reply",
    });
    assert.equal(deliveredReply.delivered, true);

    const nextAsk = await orchestrator.send(planner.sessionId!, {
      messageId: "reverse-after-delivered-reply",
      text: "Now can I ask?",
      expectsReply: true,
    });
    assert.equal(nextAsk.delivered, true);
  } finally {
    await cleanup();
  }
});

test("regular intercom ask cancellation clears broker mutual-ask edge", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    const harness = createExtensionHarness("cancel-cleanup-worker");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const worker = await waitForSessionByName(orchestrator, "cancel-cleanup-worker");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const controller = new AbortController();
    const cancelledMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const cancelledResultPromise = intercomTool.execute("ask-cancelled", { action: "ask", to: "orchestrator", message: "Should I continue?" }, controller.signal, undefined, harness.ctx);
    await cancelledMessage;
    controller.abort();
    const cancelledResult = await cancelledResultPromise;
    assert.equal(cancelledResult.details?.error, true);
    assert.match(cancelledResult.content[0]?.text ?? "", /Cancelled/);

    const reverseAsk = await orchestrator.send(worker.id, {
      messageId: "reverse-after-cancel",
      text: "Can I ask after your cancellation?",
      expectsReply: true,
    });
    assert.equal(reverseAsk.delivered, true);
    await harness.emitLifecycle("session_shutdown");
  } finally {
    await cleanup();
  }
});

test("child supervisor tool clears reply waiter when cancelled", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const controller = new AbortController();
      const cancelledMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const cancelledResultPromise = supervisorTool.execute("ask-cancelled", { reason: "need_decision", message: "Should I continue?" }, controller.signal, undefined, harness.ctx);
      await cancelledMessage;
      controller.abort();
      const cancelledResult = await cancelledResultPromise;
      assert.equal(cancelledResult.details?.error, true);
      assert.match(cancelledResult.content[0]?.text ?? "", /Cancelled/);

      const nextMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const nextResultPromise = supervisorTool.execute("ask-next", { reason: "need_decision", message: "Can I ask again?" }, new AbortController().signal, undefined, harness.ctx);
      const [from, message] = await nextMessage;
      assert.match(message.content.text, /Can I ask again/);
      const reply = await orchestrator.send(from.id, { text: "Yes.", replyTo: message.id });
      assert.equal(reply.delivered, true);
      const nextResult = await nextResultPromise;
      assert.notEqual(nextResult.details?.error, true);
      assert.match(nextResult.content[0]?.text ?? "", /Yes\./);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("full ask/reply round-trip works with reply target resolved from current turn context", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-current-turn";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
      messageId: askId,
      text: "What should I do next?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const [from, message] = await askPromise;
    const context = replyTracker.recordIncomingMessage(from, message, Date.now());
    replyTracker.queueTurnContext(context);
    replyTracker.beginTurn(Date.now());

    const target = replyTracker.resolveReplyTarget({}, Date.now());
    const sent = await orchestrator.send(target.from.id, {
      text: "Ship it.",
      replyTo: target.message.id,
    });
    assert.equal(sent.delivered, true);
    replyTracker.markReplied(target.message.id);

    const reply = await replyPromise;
    assert.equal(reply.message.content.text, "Ship it.");
    assert.equal(reply.message.replyTo, askId);
    assert.deepEqual(replyTracker.listPending(Date.now()), []);
  } finally {
    await cleanup();
  }
});

test("intercom reply targets exact replyTo when multiple asks are pending", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness("reply-target-worker");

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const worker = await waitForSessionByName(planner, "reply-target-worker");

    assert.equal((await planner.send(worker.id, { messageId: "reply-target-1", text: "First?", expectsReply: true })).delivered, true);
    assert.equal((await orchestrator.send(worker.id, { messageId: "reply-target-2", text: "Second?", expectsReply: true })).delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const replyReceived = waitForReply(orchestrator, "reply-target-2");
    const result = await intercomTool.execute("reply-exact", {
      action: "reply",
      message: "Second answer.",
      replyTo: "reply-target-2",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.notEqual(result.details?.error, true);
    const reply = await replyReceived;
    assert.equal(reply.message.content.text, "Second answer.");

    const pending = await intercomTool.execute("pending-after-exact", { action: "pending" }, new AbortController().signal, undefined, harness.ctx);
    assert.match(pending.content[0]?.text ?? "", /reply-target-1/);
    assert.doesNotMatch(pending.content[0]?.text ?? "", /reply-target-2/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("intercom reply dismisses stale pending ask only when sender session is gone", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness("stale-reply-worker");

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const worker = await waitForSessionByName(planner, "stale-reply-worker");
    assert.equal((await planner.send(worker.id, { messageId: "stale-reply-ask", text: "Still there?", expectsReply: true })).delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await planner.disconnect();

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("reply-stale", {
      action: "reply",
      message: "No sender remains.",
      replyTo: "stale-reply-ask",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(result.details?.delivered, false);
    assert.equal(result.details?.reason, "Session not found");

    const pending = await intercomTool.execute("pending-after-stale", { action: "pending" }, new AbortController().signal, undefined, harness.ctx);
    assert.match(pending.content[0]?.text ?? "", /No unresolved inbound asks/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("subagent control intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const events = new EventEmitter();
  const sentMessages: Array<{ message: { customType?: string; content?: string }; options?: { triggerTurn?: boolean } }> = [];
  const pi = {
    getSessionName: () => "orchestrator",
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: () => undefined,
    registerMessageRenderer: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: (message: { customType?: string; content?: string }, options?: { triggerTurn?: boolean }) => {
      sentMessages.push({ message, options });
    },
    appendEntry: () => undefined,
  };

  piIntercomExtension(pi as never);
  pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    message: "subagent needs attention\n\nworker needs attention in run 78f659a3.",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.message.customType, "intercom_message");
  assert.match(sentMessages[0]?.message.content ?? "", /From subagent-control/);
  assert.match(sentMessages[0]?.message.content ?? "", /worker needs attention in run 78f659a3/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
});

test("subagent result intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const events = new EventEmitter();
  const sentMessages: Array<{ message: { customType?: string; content?: string }; options?: { triggerTurn?: boolean } }> = [];
  const deliveryAcks: unknown[] = [];
  events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));
  const pi = {
    getSessionName: () => "orchestrator",
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: () => undefined,
    registerMessageRenderer: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: (message: { customType?: string; content?: string }, options?: { triggerTurn?: boolean }) => {
      sentMessages.push({ message, options });
    },
    appendEntry: () => undefined,
  };

  piIntercomExtension(pi as never);
  pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-1",
    message: "subagent result\n\nRun: 78f659a3\nAgent: worker\nStatus: completed",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.message.customType, "intercom_message");
  assert.match(sentMessages[0]?.message.content ?? "", /From subagent-result/);
  assert.match(sentMessages[0]?.message.content ?? "", /Status: completed/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-1", delivered: true }]);
});

test("async ask can be replied to later from the single pending ask fallback", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-later";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
      messageId: askId,
      text: "Need an answer later.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const [from, message] = await askPromise;
    replyTracker.recordIncomingMessage(from, message, Date.now());

    const target = replyTracker.resolveReplyTarget({}, Date.now());
    const sent = await orchestrator.send(target.from.id, {
      text: "Answering later worked.",
      replyTo: target.message.id,
    });
    assert.equal(sent.delivered, true);
    replyTracker.markReplied(target.message.id);

    const reply = await replyPromise;
    assert.equal(reply.message.content.text, "Answering later worked.");
    assert.equal(reply.message.replyTo, askId);
  } finally {
    await cleanup();
  }
});
