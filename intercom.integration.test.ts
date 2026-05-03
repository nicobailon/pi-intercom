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
  isError: boolean;
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

function createExtensionHarness(sessionName = "child-worker", options: {
  abort?: () => void;
  hasUI?: boolean;
  isIdle?: () => boolean;
  ui?: unknown;
} = {}) {
  const events = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: CapturedTool[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: { customType?: string; content?: string; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  const pi = {
    getSessionName: () => sessionName,
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
    model: { id: "child-model" },
    sessionManager: { getSessionId: () => "session-child-test" },
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
  };
}

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
      assert.equal(askResult.isError, false);
      assert.match(askResult.content[0]?.text ?? "", /Use the stable API/);

      const updateReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Found a schema mismatch." }, new AbortController().signal, undefined, harness.ctx);
      const [_updateFrom, updateMessage] = await updateReceived;
      assert.equal(updateMessage.expectsReply, undefined);
      assert.match(updateMessage.content.text, /Subagent progress update/);
      assert.match(updateMessage.content.text, /Run: 78f659a3/);
      assert.match(updateMessage.content.text, /Agent: worker/);
      assert.match(updateMessage.content.text, /Found a schema mismatch/);
      assert.equal(updateResult.isError, false);

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
      assert.equal(interviewResult.isError, false);
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
      assert.equal(invalidReplyResult.isError, false);
      assert.equal(invalidReplyResult.details?.structuredReply, undefined);
      assert.match(String(invalidReplyResult.details?.structuredReplyParseError), /must match one of the question options/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
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
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Invalid reason/);

    const missingMessageResult = await supervisorTool.execute("invalid-message", { reason: "need_decision" }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(missingMessageResult.isError, true);
    assert.match(missingMessageResult.content[0]?.text ?? "", /Missing 'message'/);

    const invalidInterviewResult = await supervisorTool.execute("invalid-interview", { reason: "interview_request", interview: { title: "Bad" } }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInterviewResult.isError, true);
    assert.match(invalidInterviewResult.content[0]?.text ?? "", /interview\.questions must be a non-empty array/);

    const invalidInfoOptionsResult = await supervisorTool.execute("invalid-info-options", {
      reason: "interview_request",
      interview: {
        questions: [{ id: "context", type: "info", question: "Context", options: ["Not an answer"] }],
      },
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInfoOptionsResult.isError, true);
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
      assert.equal(updateResult.isError, true);
      assert.match(updateResult.content[0]?.text ?? "", /Session not found/);
      assert.equal(updateResult.details?.reason, "Session not found");

      const askResult = await supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which path?" }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(askResult.isError, true);
      assert.match(askResult.content[0]?.text ?? "", /Session not found/);

      const secondAskResult = await supervisorTool.execute("ask-2", { reason: "need_decision", message: "Still blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(secondAskResult.isError, true);
      assert.match(secondAskResult.content[0]?.text ?? "", /Session not found/);
      assert.doesNotMatch(secondAskResult.content[0]?.text ?? "", /Already waiting/);
      await harness.emitLifecycle("session_shutdown");
    });
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
      assert.equal(cancelledResult.isError, true);
      assert.match(cancelledResult.content[0]?.text ?? "", /Cancelled/);

      const nextMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const nextResultPromise = supervisorTool.execute("ask-next", { reason: "need_decision", message: "Can I ask again?" }, new AbortController().signal, undefined, harness.ctx);
      const [from, message] = await nextMessage;
      assert.match(message.content.text, /Can I ask again/);
      const reply = await orchestrator.send(from.id, { text: "Yes.", replyTo: message.id });
      assert.equal(reply.delivered, true);
      const nextResult = await nextResultPromise;
      assert.equal(nextResult.isError, false);
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
