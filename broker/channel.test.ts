import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { IntercomClient } from "./client.ts";
import type { Message, SessionInfo } from "../types.ts";

const repoDir = process.cwd();

async function startBroker(agentDir: string): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn(process.execPath, [path.join(repoDir, "node_modules/tsx/dist/cli.mjs"), path.join(repoDir, "broker/broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`broker startup timeout${stderr ? `: ${stderr}` : ""}`)), 10_000);
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    broker.once("exit", (code, signal) => reject(new Error(`broker exited (${code ?? signal})${stderr ? `: ${stderr}` : ""}`)));
  });
  return broker;
}

async function waitForMessage(client: IntercomClient, predicate: (from: SessionInfo, message: Message) => boolean): Promise<[SessionInfo, Message]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error("message timeout"));
    }, 5_000);
    const onMessage = (from: SessionInfo, message: Message) => {
      if (!predicate(from, message)) return;
      clearTimeout(timeout);
      client.off("message", onMessage);
      resolve([from, message]);
    };
    client.on("message", onMessage);
  });
}

async function closeBroker(broker: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!broker) return;
  broker.kill("SIGTERM");
  await once(broker, "exit").catch(() => undefined);
}

function registration(name: string, cwd: string) {
  return { name, cwd, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() };
}

test("channel-v1 establishes exact endpoint bindings and assigns executor identities", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "icv1-"));
  const broker = await startBroker(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sender = new IntercomClient();
  const receiver = new IntercomClient();
  try {
    await sender.connect(registration("planner", agentDir), "planner-id");
    await receiver.connect({ ...registration("runtime-alias", agentDir), runtimeFallbackAlias: true }, "receiver-id");
    const binding = await sender.openChannel("receiver-id");
    const self = binding.channel.members.find((member) => member.memberId === binding.selfMemberId)!;
    const target = binding.channel.members.find((member) => member.memberId === binding.targetMemberId)!;
    assert.equal(self.agentName, "planner");
    assert.equal(target.agentName, "执行者-2");
    assert.equal(target.sessionId, "receiver-id");
    assert.equal(binding.channel.lifecycle, "ephemeral");

    const received = waitForMessage(receiver, (_from, message) => message.content.text === "hello");
    const result = await sender.send("receiver-id", { messageId: "channel-message-1", text: "hello" });
    assert.equal(result.delivered, true);
    assert.equal(result.state, "socket_delivered");
    const [, message] = await received;
    assert.equal(message.channel?.channelId, binding.channel.channelId);
    assert.equal(message.channel?.fromMemberId, binding.selfMemberId);
    assert.equal(message.channel?.toMemberId, binding.targetMemberId);

    // A second send performs a broker handshake but reuses the same logical channel.
    const reused = await sender.openChannel("receiver-id");
    assert.equal(reused.channel.channelId, binding.channel.channelId);
    assert.equal(reused.selfMemberId, binding.selfMemberId);
    assert.equal(reused.targetMemberId, binding.targetMemberId);

    await sender.closeChannel(reused);
    const reopened = await sender.openChannel("receiver-id");
    assert.notEqual(reopened.channel.channelId, binding.channel.channelId);
  } finally {
    await sender.disconnect().catch(() => undefined);
    await receiver.disconnect().catch(() => undefined);
    await closeBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("channel-v1 makes duplicate IDs idempotent and rejects changed payloads", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "icid-"));
  const broker = await startBroker(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sender = new IntercomClient();
  const receiver = new IntercomClient();
  const received: string[] = [];
  receiver.on("message", (_from, message) => received.push(message.content.text));
  try {
    await sender.connect(registration("sender", agentDir), "sender-id");
    await receiver.connect(registration("receiver", agentDir), "receiver-id");
    const first = await sender.send("receiver-id", { messageId: "same-id", text: "same payload" });
    const duplicate = await sender.send("receiver-id", { messageId: "same-id", text: "same payload" });
    const reuse = await sender.send("receiver-id", { messageId: "same-id", text: "different payload" });
    assert.equal(first.delivered, true, JSON.stringify(first));
    assert.equal(duplicate.delivered, true, JSON.stringify(duplicate));
    assert.equal(reuse.delivered, false, JSON.stringify(reuse));
    assert.equal(reuse.code, "E_MESSAGE_ID_REUSE");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(received, ["same payload"]);
  } finally {
    await sender.disconnect().catch(() => undefined);
    await receiver.disconnect().catch(() => undefined);
    await closeBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("channel membership and executor ordinals survive a broker restart", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "icrestart-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let broker = await startBroker(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const firstSender = new IntercomClient();
  const firstReceiver = new IntercomClient();
  let channelId = "";
  let epoch = "";
  try {
    await firstSender.connect(registration("planner", agentDir), "restart-sender");
    await firstReceiver.connect({ ...registration("runtime", agentDir), runtimeFallbackAlias: true }, "restart-receiver");
    const binding = await firstSender.openChannel("restart-receiver");
    channelId = binding.channel.channelId;
    epoch = binding.channel.epoch;
    await firstSender.disconnect();
    await firstReceiver.disconnect();
    await closeBroker(broker);

    broker = await startBroker(agentDir);
    const sender = new IntercomClient();
    const receiver = new IntercomClient();
    try {
      await sender.connect(registration("planner", agentDir), "restart-sender");
      await receiver.connect({ ...registration("runtime", agentDir), runtimeFallbackAlias: true }, "restart-receiver");
      const rebound = await sender.openChannel("restart-receiver");
      assert.equal(rebound.channel.channelId, channelId);
      assert.equal(rebound.channel.epoch, epoch);
      assert.deepEqual(rebound.channel.members.map((member) => member.joinOrdinal), [1, 2]);
      assert.deepEqual(rebound.channel.members.map((member) => member.agentName), ["planner", "执行者-2"]);
    } finally {
      await sender.disconnect().catch(() => undefined);
      await receiver.disconnect().catch(() => undefined);
    }
  } finally {
    await firstSender.disconnect().catch(() => undefined);
    await firstReceiver.disconnect().catch(() => undefined);
    await closeBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("static project channel policy rejects same-name endpoint swaps and outsiders", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "icpolicy-"));
  mkdirSync(path.join(agentDir, ".pi"), { recursive: true });
  writeFileSync(path.join(agentDir, ".pi", "intercom-channel.json"), JSON.stringify({
    name: "policy",
    members: [
      { name: "planner", id: "sender-id" },
      { name: "receiver", id: "receiver-id" },
    ],
  }));
  const broker = await startBroker(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sender = new IntercomClient();
  const receiver = new IntercomClient();
  const outsider = new IntercomClient();
  try {
    await sender.connect(registration("planner", agentDir), "sender-id");
    await receiver.connect(registration("receiver", agentDir), "receiver-id");
    await outsider.connect(registration("outsider", agentDir), "outsider-id");
    const allowed = await sender.send("receiver-id", { text: "allowed" });
    const rejected = await sender.send("outsider-id", { text: "outside" });
    assert.equal(allowed.delivered, true);
    assert.equal(rejected.delivered, false);
    assert.equal(rejected.code, "E_TARGET_NOT_MEMBER");
  } finally {
    await sender.disconnect().catch(() => undefined);
    await receiver.disconnect().catch(() => undefined);
    await outsider.disconnect().catch(() => undefined);
    await closeBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("channel-v1 queues only for the exact offline member and flushes after reconnect", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "icq-"));
  const broker = await startBroker(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sender = new IntercomClient();
  const receiver = new IntercomClient();
  try {
    await sender.connect(registration("sender", agentDir), "sender-id");
    await receiver.connect(registration("receiver", agentDir), "receiver-id");
    const binding = await sender.openChannel("receiver-id");
    await receiver.disconnect();
    const queued = await sender.send("receiver-id", { messageId: "queued-message", text: "offline hello" });
    assert.equal(queued.delivered, true);
    assert.equal(queued.state, "queued");

    const replacement = new IntercomClient();
    const received = waitForMessage(replacement, (_from, message) => message.id === "queued-message");
    await replacement.connect(registration("receiver", agentDir), "receiver-id");
    const [, message] = await received;
    assert.equal(message.content.text, "offline hello");
    assert.equal(message.channel?.channelId, binding.channel.channelId);
    await replacement.disconnect();
  } finally {
    await sender.disconnect().catch(() => undefined);
    await receiver.disconnect().catch(() => undefined);
    await closeBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
