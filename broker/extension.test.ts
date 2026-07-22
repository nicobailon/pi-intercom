import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrokerMessage, SessionRegistration } from "../types.ts";
import { IntercomClient } from "./client.ts";
import { ExtensionStateManager } from "./extension-state.ts";

const repoDir = process.cwd();

function registration(name: string, startedAt: number, ownerEligible?: boolean): SessionRegistration {
  return {
    name,
    cwd: "/test",
    model: "test-model",
    pid: process.pid,
    startedAt,
    lastActivity: Date.now(),
    ...(ownerEligible === undefined
      ? {}
      : { extensions: [{ namespace: "test/v1", ownerEligible }] }),
  };
}

async function waitFor(
  messages: BrokerMessage[],
  predicate: (message: BrokerMessage) => boolean,
  timeoutMs = 3000,
): Promise<BrokerMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for broker message");
}

async function startBroker(agentDir: string): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn(
    process.execPath,
    [path.join(repoDir, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoDir, "broker", "broker.ts")],
    {
      cwd: repoDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Broker startup timed out")), 10_000);
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    broker.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Broker exited before startup (${code ?? signal})`));
    });
  });
  await ready;
  return broker;
}

async function stopBroker(broker: ChildProcessWithoutNullStreams): Promise<void> {
  if (broker.exitCode !== null) return;
  broker.kill("SIGTERM");
  await once(broker, "exit");
}

test("extension bus negotiates, routes, elects an owner, and persists state", { concurrency: false, timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-extension-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const broker = await startBroker(agentDir);
  const clients: IntercomClient[] = [];

  try {
    const invalidNamespace = new IntercomClient();
    await assert.rejects(
      invalidNamespace.connect({
        ...registration("invalid", Date.now()),
        extensions: [{ namespace: "Invalid Namespace", ownerEligible: true }],
      }),
    );

    const tooManyExtensions = new IntercomClient();
    await assert.rejects(
      tooManyExtensions.connect({
        ...registration("too-many", Date.now()),
        extensions: Array.from({ length: 33 }, (_, index) => ({
          namespace: `test-${index}/v1`,
          ownerEligible: true,
        })),
      }),
    );

    const owner = new IntercomClient();
    const peer = new IntercomClient();
    const legacy = new IntercomClient();
    const late = new IntercomClient();
    const peerOnlyA = new IntercomClient();
    const peerOnlyB = new IntercomClient();
    clients.push(owner, peer, legacy, late, peerOnlyA, peerOnlyB);

    const ownerMessages: BrokerMessage[] = [];
    const peerMessages: BrokerMessage[] = [];
    const legacyMessages: BrokerMessage[] = [];
    const lateMessages: BrokerMessage[] = [];
    const peerOnlyBMessages: BrokerMessage[] = [];
    const ownerErrors: Error[] = [];
    const legacyErrors: Error[] = [];
    owner.onBrokerMessage((message) => ownerMessages.push(message));
    peer.onBrokerMessage((message) => peerMessages.push(message));
    legacy.onBrokerMessage((message) => legacyMessages.push(message));
    late.onBrokerMessage((message) => lateMessages.push(message));
    peerOnlyB.onBrokerMessage((message) => peerOnlyBMessages.push(message));
    owner.on("error", (error) => ownerErrors.push(error));
    peer.on("error", () => {});
    legacy.on("error", (error) => legacyErrors.push(error));
    late.on("error", () => {});
    peerOnlyA.on("error", () => {});
    peerOnlyB.on("error", () => {});

    const now = Date.now();
    await owner.connect(registration("owner", now - 1000, true), "owner-id");

    const invalidReplacement = new IntercomClient();
    await assert.rejects(invalidReplacement.connect({
      ...registration("invalid-replacement", now),
      extensions: [{ namespace: "Invalid Namespace", ownerEligible: true }],
    }, "owner-id"));
    assert.equal((await owner.listSessions()).some((session) => session.id === "owner-id"), true);
    await invalidReplacement.disconnect().catch(() => undefined);

    await peer.connect(registration("peer", now, false), "peer-id");
    await legacy.connect(registration("legacy", now), "legacy-id");
    await late.connect(registration("late", 0), "late-id");
    await peerOnlyA.connect({
      ...registration("peer-only-a", now + 2),
      extensions: [{ namespace: "peer-only/v1", ownerEligible: false }],
    }, "peer-only-a-id");
    await peerOnlyB.connect({
      ...registration("peer-only-b", now + 3),
      extensions: [{ namespace: "peer-only/v1", ownerEligible: false }],
    }, "peer-only-b-id");

    assert.equal(owner.supportsFeature("extension-bus-v1"), true);
    assert.equal(legacy.supportsFeature("extension-bus-v1"), true, "new broker advertises support even to clients without capabilities");

    const ownerEvent = await waitFor(ownerMessages, (message) => message.type === "extension_owner");
    assert.equal(ownerEvent.type, "extension_owner");
    assert.equal(ownerEvent.ownerId, "owner-id");
    assert.ok(ownerEvent.ownerEpoch);
    const peerOwnerEvent = await waitFor(peerMessages, (message) => message.type === "extension_owner");
    assert.equal(peerOwnerEvent.type, "extension_owner");
    assert.equal(peerOwnerEvent.ownerId, "owner-id");

    late.updateExtensionCapabilities([{ namespace: "test/v1", ownerEligible: true }]);
    const lateOwnerEvent = await waitFor(lateMessages, (message) => message.type === "extension_owner");
    assert.equal(lateOwnerEvent.type, "extension_owner");
    assert.equal(lateOwnerEvent.ownerId, "owner-id", "backdated client must not seize namespace ownership");
    late.updateExtensionCapabilities([{ namespace: "test/v1", ownerEligible: false }]);

    legacy.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "capable",
      payload: { unauthorized: true },
    });
    const unauthorizedDeadline = Date.now() + 3000;
    while (Date.now() < unauthorizedDeadline && legacyErrors.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(legacyErrors[0]?.message ?? "", /has not advertised extension capability/);
    legacy.sendExtensionMessage({
      type: "extension_state_commit",
      namespace: "test/v1",
      ownerEpoch: "unauthorized",
      expectedRevision: 0,
      payload: {},
    });
    const unauthorizedState = await waitFor(
      legacyMessages,
      (message) => message.type === "extension_state_result",
    );
    assert.equal(unauthorizedState.type, "extension_state_result");
    assert.equal(unauthorizedState.committed, false);
    assert.match(unauthorizedState.reason ?? "", /has not advertised extension capability/);

    owner.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "capable",
      payload: "x".repeat(16 * 1024),
    });
    const oversizedDeadline = Date.now() + 3000;
    while (Date.now() < oversizedDeadline && !ownerErrors.some((error) => /16 KiB/.test(error.message))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ownerErrors.some((error) => /16 KiB/.test(error.message)), true);
    ownerErrors.length = 0;

    peerOnlyA.sendExtensionMessage({
      type: "extension_publish",
      namespace: "peer-only/v1",
      audience: "capable",
      payload: { kind: "peer-broadcast" },
    });
    const peerBroadcast = await waitFor(peerOnlyBMessages, (message) => message.type === "extension_message");
    assert.equal(peerBroadcast.type, "extension_message");
    assert.equal(peerBroadcast.ownerId, undefined);
    assert.equal(peerBroadcast.ownerEpoch, undefined);
    assert.deepEqual(peerBroadcast.payload, { kind: "peer-broadcast" });

    peer.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "owner",
      payload: { kind: "owner-target" },
    });
    const ownerTarget = await waitFor(
      ownerMessages,
      (message) => message.type === "extension_message"
        && (message.payload as { kind?: string }).kind === "owner-target",
    );
    assert.equal(ownerTarget.type, "extension_message");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      peerMessages.some((message) => message.type === "extension_message"
        && (message.payload as { kind?: string }).kind === "owner-target"),
      false,
    );

    owner.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "capable",
      ownerOnly: true,
      ownerEpoch: ownerEvent.ownerEpoch,
      payload: { kind: "assignment" },
    });
    const received = await waitFor(peerMessages, (message) => message.type === "extension_message");
    assert.equal(received.type, "extension_message");
    assert.deepEqual(received.payload, { kind: "assignment" });
    const lateReceived = await waitFor(lateMessages, (message) => message.type === "extension_message");
    assert.equal(lateReceived.type, "extension_message");
    assert.deepEqual(lateReceived.payload, { kind: "assignment" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(legacyMessages.some((message) => message.type === "extension_message"), false);

    owner.sendExtensionMessage({
      type: "extension_state_commit",
      namespace: "test/v1",
      ownerEpoch: ownerEvent.ownerEpoch!,
      expectedRevision: 0,
      payload: { groups: ["alpha"] },
    });
    const committed = await waitFor(ownerMessages, (message) => message.type === "extension_state_result");
    assert.equal(committed.type, "extension_state_result");
    assert.equal(committed.committed, true);
    assert.equal(committed.revision, 1);
    const state = await waitFor(peerMessages, (message) => message.type === "extension_state");
    assert.equal(state.type, "extension_state");
    assert.deepEqual(state.payload, { groups: ["alpha"] });

    owner.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "capable",
      ownerOnly: true,
      payload: {},
    });
    const missingEpochDeadline = Date.now() + 3000;
    while (Date.now() < missingEpochDeadline && !ownerErrors.some((error) => /ownerEpoch required/.test(error.message))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ownerErrors.some((error) => /ownerEpoch required/.test(error.message)), true);
    ownerErrors.length = 0;

    owner.sendExtensionMessage({
      type: "extension_publish",
      namespace: "test/v1",
      audience: "capable",
      ownerOnly: true,
      ownerEpoch: "stale",
      payload: {},
    });
    await waitFor(
      ownerMessages,
      (message) => message.type === "error" && message.error === "Owner validation failed",
    ).catch(async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && ownerErrors.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(ownerErrors[0]?.message ?? "", /Owner validation failed/);
      return { type: "error", error: ownerErrors[0]!.message } as BrokerMessage;
    });

    await owner.disconnect();
    const noOwner = await waitFor(
      peerMessages,
      (message) => message.type === "extension_owner" && message.ownerId === undefined,
    );
    assert.equal(noOwner.type, "extension_owner");

    const replacement = new IntercomClient();
    clients.push(replacement);
    const replacementMessages: BrokerMessage[] = [];
    replacement.onBrokerMessage((message) => replacementMessages.push(message));
    replacement.on("error", () => {});
    await replacement.connect(registration("replacement", now + 1, true), "owner-id");
    const replacementOwner = await waitFor(replacementMessages, (message) => message.type === "extension_owner");
    assert.equal(replacementOwner.type, "extension_owner");
    assert.notEqual(replacementOwner.ownerEpoch, ownerEvent.ownerEpoch);
    const restored = await waitFor(replacementMessages, (message) => message.type === "extension_state");
    assert.equal(restored.type, "extension_state");
    assert.equal(restored.revision, 1);
  } finally {
    await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
    await stopBroker(broker);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("extension state compare-and-swap rejects stale and invalid revisions", () => {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-state-cas-"));
  try {
    const manager = new ExtensionStateManager(runtimeDir);
    assert.deepEqual(manager.commitState("test/v1", 0, { version: 1 }), { committed: true, revision: 1 });
    assert.deepEqual(manager.commitState("test/v1", 0, { version: 2 }), {
      committed: false,
      revision: 1,
      reason: "Revision mismatch",
      payload: { version: 1 },
    });
    assert.deepEqual(manager.commitState("test/v1", -1, { version: 2 }), {
      committed: false,
      revision: 1,
      reason: "Invalid expected revision",
    });
    assert.deepEqual(manager.commitState("test/v1", 1, { version: 2 }), { committed: true, revision: 2 });
    assert.deepEqual(manager.commitState("test/v1", 2, "x".repeat(64 * 1024)), {
      committed: false,
      revision: 2,
      reason: "Invalid extension state or payload exceeds 64 KiB limit",
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.deepEqual(manager.commitState("test/v1", 2, circular), {
      committed: false,
      revision: 2,
      reason: "Invalid extension state or payload exceeds 64 KiB limit",
    });
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("extension state falls back to a valid backup", () => {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-state-"));
  try {
    const manager = new ExtensionStateManager(runtimeDir);
    assert.equal(manager.commitState("test/v1", 0, { version: 1 }).committed, true);
    assert.equal(manager.commitState("test/v1", 1, { version: 2 }).committed, true);

    const stateDir = path.join(runtimeDir, "extension-state");
    const files = readdirSync(stateDir);
    const primary = files.find((file) => file.endsWith(".json"));
    assert.ok(primary);
    writeFileSync(path.join(stateDir, primary!), "corrupt", "utf8");

    const recovered = new ExtensionStateManager(runtimeDir).loadState("test/v1");
    assert.deepEqual(recovered, { revision: 1, payload: { version: 1 } });
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
