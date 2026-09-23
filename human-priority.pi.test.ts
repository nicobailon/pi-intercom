// Ordering is measured from a real AgentSession's model inputs, not mocked delivery options.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { Message, MessageReceipt, SessionInfo } from "./types.ts";

const repoDir = process.cwd();
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-priority-home-"));
const runtimeAgentDir = process.platform === "win32" ? sharedHomeDir : mkdtempSync("/tmp/piic-");
mkdirSync(path.join(runtimeAgentDir, "intercom"), { recursive: true });
writeFileSync(path.join(runtimeAgentDir, "intercom", "config.json"), JSON.stringify({ busyDelivery: "human-first" }));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
// The broker location derives from the agent dir; a host Pi session must never be touched.
process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
delete process.env.PI_INTERCOM_SCOPE_ID;
delete process.env.PI_INTERCOM_SESSION_ID;
delete process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET;
delete process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(sharedHomeDir, { recursive: true, force: true });
  rmSync(runtimeAgentDir, { recursive: true, force: true });
});

const { IntercomClient } = await import("./broker/client.ts");
const { getTsxCliPath } = await import("./broker/spawn.ts");
const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { default: piIntercomExtension } = await import("./index.ts");

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface ModelInput {
  role: string;
  text: string;
}

function contextText(message: { role: string; content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startBroker(): Promise<ChildProcess> {
  const broker: ChildProcess = spawn(process.execPath, [getTsxCliPath(), path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Broker startup timed out")), 10000);
      broker.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Intercom broker started")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      broker.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
      });
    });
  } catch (error) {
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    }
    throw error;
  }
  return broker;
}

interface PiWorker {
  session: AgentSessionInstance;
  modelInputs: ModelInput[];
  releaseModel: () => void;
  modelCalls: () => number;
  waitForModelCall: (count: number) => Promise<void>;
  settledCount: () => number;
  waitForSettled: (count: number) => Promise<void>;
  shutdown: () => Promise<void>;
}

async function createPiWorker(name: string): Promise<PiWorker> {
  const agentDir = mkdtempSync(path.join(sharedHomeDir, `agent-${name}-`));
  const faux = fauxProvider({ provider: `faux-${name}` });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();

  const modelInputs: ModelInput[] = [];
  const releases: Array<() => void> = [];
  let modelCallCount = 0;
  let settledCount = 0;
  faux.setResponses(Array.from({ length: 8 }, (_, index) => async (context) => {
    for (const message of context.messages) {
      if (message.role !== "user" && message.role !== "custom") continue;
      const text = contextText(message);
      if (!modelInputs.some((input) => input.role === message.role && input.text === text)) {
        modelInputs.push({ role: message.role, text });
      }
    }
    modelCallCount += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return fauxAssistantMessage(`response ${index + 1}`);
  }));

  const loader = new DefaultResourceLoader({
    cwd: repoDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "pi-intercom", factory: (pi) => piIntercomExtension(pi) },
      {
        name: "priority-probe",
        factory: (pi) => {
          pi.on("agent_settled", () => { settledCount += 1; });
        },
      },
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: repoDir,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(repoDir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...(session.extensionRunner.getUIContext()),
      notify: () => undefined,
    },
  });
  session.setSessionName(name);

  return {
    session,
    modelInputs,
    releaseModel: () => {
      const release = releases.shift();
      if (!release) throw new Error("No blocked model call to release");
      release();
    },
    modelCalls: () => modelCallCount,
    waitForModelCall: (count) => waitFor(() => modelCallCount >= count && releases.length > 0, `model call ${count}`),
    settledCount: () => settledCount,
    waitForSettled: (count) => waitFor(() => settledCount >= count, `agent_settled #${count}`),
    shutdown: async () => {
      // Unblock any scripted model call so abort() can reach idle.
      while (releases.length > 0) releases.shift()!();
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

interface Fixture {
  planner: InstanceType<typeof IntercomClient>;
  createWorker: (name: string) => Promise<PiWorker>;
  receipts: Map<string, string[]>;
  waitForReceipt: (messageId: string, status: string) => Promise<void>;
  waitForSession: (name: string) => Promise<SessionInfo>;
  cleanup: () => Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
  const broker = await startBroker();
  const planner = new IntercomClient();
  try {
    await planner.connect({ name: "planner", cwd: repoDir, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
  } catch (error) {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    throw error;
  }
  const receipts = new Map<string, string[]>();
  planner.onMessageReceipt((_from: SessionInfo, receipt: MessageReceipt) => {
    const statuses = receipts.get(receipt.messageId) ?? [];
    statuses.push(receipt.detail ? `${receipt.status}:${receipt.detail}` : receipt.status);
    receipts.set(receipt.messageId, statuses);
  });
  return {
    planner,
    createWorker: async (name) => {
      try {
        return await createPiWorker(name);
      } catch (error) {
        await planner.disconnect().catch(() => undefined);
        broker.kill("SIGTERM");
        await once(broker, "exit").catch(() => undefined);
        throw error;
      }
    },
    receipts,
    waitForReceipt: (messageId, status) => waitFor(
      () => (receipts.get(messageId) ?? []).some((entry) => entry === status || entry.startsWith(`${status}:`)),
      `${status} receipt for ${messageId}`,
    ),
    waitForSession: async (name) => {
      let found: SessionInfo | undefined;
      await waitFor(() => {
        void planner.listSessions().then((sessions: SessionInfo[]) => { found = sessions.find((session) => session.name === name); });
        return found !== undefined;
      }, `session ${name}`);
      return found!;
    },
    cleanup: async () => {
      await planner.disconnect().catch(() => undefined);
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    },
  };
}

function statuses(fixture: Fixture, messageId: string): string[] {
  return (fixture.receipts.get(messageId) ?? []).map((entry) => entry.split(":")[0]!);
}

test("busy interactive peer message is held, then steered into the same run at the next turn boundary", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("hold-worker");
  try {
    const target = await fixture.waitForSession("hold-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);

    assert.equal((await fixture.planner.send(target.id, { messageId: "held-peer", text: "peer while busy" })).delivered, true);
    await fixture.waitForReceipt("held-peer", "queued");
    assert.equal(worker.session.pendingMessageCount, 0, "held peer must not enter Pi's steering/followUp queues");
    assert.ok(!statuses(fixture, "held-peer").includes("injected"), "held peer must not be injected mid-turn");

    worker.releaseModel();
    await fixture.waitForReceipt("held-peer", "injected");
    await worker.waitForModelCall(2);
    assert.equal(worker.settledCount(), 0, "the peer rode the running human run; no settle boundary was needed");
    worker.releaseModel();
    await humanRun;
    await worker.waitForSettled(1);

    const texts = worker.modelInputs.map((input) => input.text);
    assert.equal(texts[0], "human task 1");
    assert.match(texts[1] ?? "", /peer while busy/);
    assert.deepEqual(statuses(fixture, "held-peer"), ["receiver_received", "acknowledged", "queued", "injected"]);
    assert.equal(worker.session.isIdle, true);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("human steer and followUp that arrive after a held peer are processed before the peer", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("order-worker");
  try {
    const target = await fixture.waitForSession("order-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);

    assert.equal((await fixture.planner.send(target.id, { messageId: "peer-before-humans", text: "peer before humans" })).delivered, true);
    await fixture.waitForReceipt("peer-before-humans", "queued");
    await worker.session.prompt("human steer 2", { streamingBehavior: "steer" });
    await worker.session.prompt("human follow-up 3", { streamingBehavior: "followUp" });
    assert.equal(worker.session.pendingMessageCount, 2, "only the two human messages are in Pi's queues");

    worker.releaseModel();
    await worker.waitForModelCall(2);
    assert.ok(!statuses(fixture, "peer-before-humans").includes("injected"), "peer must stay held while human steer is pending");
    worker.releaseModel();
    await worker.waitForModelCall(3);
    assert.ok(!statuses(fixture, "peer-before-humans").includes("injected"), "peer must stay held while human followUp is pending");
    worker.releaseModel();
    await fixture.waitForReceipt("peer-before-humans", "injected");
    await worker.waitForModelCall(4);
    assert.equal(worker.settledCount(), 0, "peer was steered into the still-running human run, not a new one");
    worker.releaseModel();
    await humanRun;
    await worker.waitForSettled(1);

    const texts = worker.modelInputs.map((input) => input.text);
    assert.equal(texts[0], "human task 1");
    assert.equal(texts[1], "human steer 2");
    assert.equal(texts[2], "human follow-up 3");
    assert.match(texts[3] ?? "", /peer before humans/);
    assert.equal(texts.length, 4);
    assert.equal(worker.session.isIdle, true);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("multiple held peers drain one per turn inside the run and human input between them wins", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("multi-worker");
  try {
    const target = await fixture.waitForSession("multi-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);

    assert.equal((await fixture.planner.send(target.id, { messageId: "peer-a", text: "peer A" })).delivered, true);
    assert.equal((await fixture.planner.send(target.id, { messageId: "peer-b", text: "peer B" })).delivered, true);
    await fixture.waitForReceipt("peer-a", "queued");
    await fixture.waitForReceipt("peer-b", "queued");

    worker.releaseModel();
    await fixture.waitForReceipt("peer-a", "injected");
    await worker.waitForModelCall(2);
    assert.ok(!statuses(fixture, "peer-b").includes("injected"), "second peer waits for the next turn boundary");
    assert.equal(worker.settledCount(), 0, "still the original human run");

    await worker.session.prompt("human steer 2", { streamingBehavior: "steer" });
    worker.releaseModel();
    await worker.waitForModelCall(3);
    assert.ok(!statuses(fixture, "peer-b").includes("injected"));
    worker.releaseModel();
    await fixture.waitForReceipt("peer-b", "injected");
    await worker.waitForModelCall(4);
    worker.releaseModel();
    await humanRun;
    await worker.waitForSettled(1);

    const texts = worker.modelInputs.map((input) => input.text);
    assert.equal(texts[0], "human task 1");
    assert.match(texts[1] ?? "", /peer A/);
    assert.equal(texts[2], "human steer 2");
    assert.match(texts[3] ?? "", /peer B/);
    assert.equal(texts.length, 4);
    assert.equal(worker.session.isIdle, true);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("held peers hand off one triggered turn when a busy run ends without a turn boundary", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("handoff-worker");
  try {
    const target = await fixture.waitForSession("handoff-worker");
    const humanRun = worker.session.prompt("human task");
    await worker.waitForModelCall(1);
    await fixture.planner.send(target.id, { messageId: "handoff-a", text: "first peer" });
    await fixture.planner.send(target.id, { messageId: "handoff-b", text: "second peer" });
    await fixture.waitForReceipt("handoff-b", "queued");
    const abort = worker.session.abort();
    worker.releaseModel();
    await abort;
    await humanRun;
    await fixture.waitForReceipt("handoff-a", "injected");
    await worker.waitForModelCall(2);
    assert.ok(!statuses(fixture, "handoff-b").includes("injected"));
    worker.releaseModel();
    await fixture.waitForReceipt("handoff-b", "injected");
    await worker.waitForModelCall(3);
    worker.releaseModel();
    await worker.waitForSettled(2);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("a held ask answered during the busy run is dropped with an acknowledged receipt, not injected", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("early-answer-worker");
  try {
    const target = await fixture.waitForSession("early-answer-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);
    assert.equal((await fixture.planner.send(target.id, { messageId: "early-ask", text: "Early question?", expectsReply: true })).delivered, true);
    await fixture.waitForReceipt("early-ask", "queued");

    const intercomTool = worker.session.state.tools.find((tool) => tool.name === "intercom");
    assert.ok(intercomTool, "intercom tool registered on the real session");
    const result = await intercomTool.execute("early-reply", { action: "reply", replyTo: "early-ask", message: "Answered early." }, new AbortController().signal, undefined);
    assert.equal((result.details as { delivered?: boolean } | undefined)?.delivered, true);
    await waitFor(() => (fixture.receipts.get("early-ask") ?? []).includes("acknowledged:answered before injection"), "answered-before-injection receipt");

    worker.releaseModel();
    await humanRun;
    await worker.waitForSettled(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(worker.modelCalls(), 1, "no handoff turn for the answered ask");
    assert.ok(!worker.modelInputs.some((input) => /Early question\?/.test(input.text)), "answered ask never reached the model");
    assert.deepEqual(statuses(fixture, "early-ask").filter((status) => status !== "receiver_received"), ["acknowledged", "queued", "acknowledged"]);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("cancelled and superseded held peers are dropped before injection", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("drop-worker");
  try {
    const target = await fixture.waitForSession("drop-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);

    assert.equal((await fixture.planner.send(target.id, { messageId: "cancel-me", text: "cancel me", expectsReply: true })).delivered, true);
    assert.equal((await fixture.planner.send(target.id, { messageId: "old-version", text: "old version" })).delivered, true);
    await fixture.waitForReceipt("cancel-me", "queued");
    await fixture.waitForReceipt("old-version", "queued");
    assert.equal((await fixture.planner.cancelMessage("cancel-me")).delivered, true);
    await fixture.waitForReceipt("cancel-me", "cancelled");
    assert.equal((await fixture.planner.send(target.id, { messageId: "new-version", text: "new version", supersedes: "old-version" })).delivered, true);
    await fixture.waitForReceipt("old-version", "superseded");
    await fixture.waitForReceipt("new-version", "queued");

    worker.releaseModel();
    await fixture.waitForReceipt("new-version", "injected");
    await worker.waitForModelCall(2);
    worker.releaseModel();
    await humanRun;
    await worker.waitForSettled(1);
    assert.equal(worker.session.isIdle, true);

    const texts = worker.modelInputs.map((input) => input.text);
    assert.equal(texts.length, 2);
    assert.match(texts[1] ?? "", /new version/);
    assert.ok(!texts.some((text) => /cancel me|old version/.test(text)), "dropped entries never reach the model");
    assert.ok(!statuses(fixture, "cancel-me").includes("injected"));
    assert.ok(!statuses(fixture, "old-version").includes("injected"));
    assert.deepEqual(statuses(fixture, "cancel-me"), ["receiver_received", "acknowledged", "queued", "cancelled"]);
    assert.deepEqual(statuses(fixture, "old-version"), ["receiver_received", "acknowledged", "queued", "superseded"]);
  } finally {
    await worker.shutdown().finally(() => fixture.cleanup());
  }
});

test("held peers expire on session shutdown instead of being injected later", { concurrency: false }, async () => {
  const fixture = await setupFixture();
  const worker = await fixture.createWorker("expire-worker");
  try {
    const target = await fixture.waitForSession("expire-worker");
    const humanRun = worker.session.prompt("human task 1");
    await worker.waitForModelCall(1);
    assert.equal((await fixture.planner.send(target.id, { messageId: "expire-me", text: "expire me" })).delivered, true);
    await fixture.waitForReceipt("expire-me", "queued");

    await worker.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    worker.releaseModel();
    await humanRun;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(statuses(fixture, "expire-me"), ["receiver_received", "acknowledged", "queued", "expired"]);
    assert.equal(worker.modelInputs.length, 1);
  } finally {
    worker.session.dispose();
    await fixture.cleanup();
  }
});
