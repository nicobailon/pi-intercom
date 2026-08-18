/**
 * End-to-end smoke test for the intercom fixed-channel guard:
 * real broker + real clients, exercising the same decision functions the
 * intercom tool wires in (channel membership, intended-recipient refusal,
 * identity-id dual binding, delivery-receipt labels, backward compatibility).
 * Run from the pi-intercom package root:
 *   npx tsx --test scripts/guard-smoke.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { IntercomClient } from "../broker/client.ts";
import {
  channelRejectsSession,
  findChannelFile,
  formatTargetLabel,
  intendedMismatchReason,
  loadChannel,
  resolveBoundId,
} from "../channel.ts";

const repoDir = process.cwd();

async function startBroker(agentDir: string): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn(
    process.execPath,
    [join(repoDir, "node_modules", "tsx", "dist", "cli.mjs"), join(repoDir, "broker", "broker.ts")],
    { cwd: repoDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Broker startup timed out")), 10_000);
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    broker.once("exit", (code, signal) => reject(new Error(`Broker exited before startup (${code ?? signal})`)));
  });
  return broker;
}

/** Track incoming messages on a client so waits never race the listener. */
function track(client: IntercomClient): { waitFor(text: string, timeoutMs?: number): Promise<void> } {
  const received: string[] = [];
  client.on("message", (_from: unknown, message: { content?: { text?: string } }) => {
    received.push(message.content?.text ?? "");
  });
  return {
    async waitFor(text: string, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (received.includes(text)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for message: ${text}`);
    },
  };
}

test("channel guard refuses outside-member delivery end-to-end", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "icg-"));
  const clients: IntercomClient[] = [];
  let broker: ChildProcessWithoutNullStreams | null = null;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  // Isolate the test from the real broker: point both the broker child and
  // the client connections at a temp agent dir.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    broker = await startBroker(agentDir);
    const alpha = new IntercomClient();
    const beta = new IntercomClient();
    const gamma = new IntercomClient();
    clients.push(alpha, beta, gamma);
    const alphaIn = track(alpha);
    const gammaIn = track(gamma);
    await alpha.connect({ name: "c", cwd: agentDir, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
    // Runtime alias style name — no /name, exactly like real subagent sessions.
    await beta.connect({ name: "subagent-chat-019ff8d2-b9be-7fe9", runtimeFallbackAlias: true, cwd: agentDir, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
    await gamma.connect({ name: "d", cwd: agentDir, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });

    const sessions = await alpha.listSessions();
    const c = sessions.find((s) => s.name === "c")!;
    const e = sessions.find((s) => s.name?.startsWith("subagent-chat-"))!;
    const d = sessions.find((s) => s.name === "d")!;
    assert.ok(c && e && d, "all three sessions registered");

    // --- Scenario 1: a tries to send to e while a channel {c, d} exists ---
    // (The tool layer calls these exact functions before calling client.send.)
    assert.equal(findChannelFile(agentDir), null, "no channel file yet");
    const channel = { name: "任务组", allowNameOnly: true, members: [{ name: "c", role: "发起者" }, { name: "d", role: "接受者" }] };
    const rejection = channelRejectsSession(channel, e);
    assert.match(rejection!, /is not a member/);
    // Guarded: message must NOT be sent. We assert the guard decision, then
    // send only because the guard passed for member d:
    assert.equal(channelRejectsSession(channel, d), null);
    const sendToD = await alpha.send(d.id, { text: "hello d" });
    assert.equal(sendToD.delivered, true, "member delivery accepted");
    await gammaIn.waitFor("hello d");

    // --- Scenario 2: intended-recipient refusal ---
    // c *wants* to reach d but the address resolves to e.
    const mismatch = intendedMismatchReason("d", d, e, (s) => s.id.slice(0, 8));
    assert.match(mismatch!, /Refusing to send/);
    assert.match(mismatch!, /"d"/);
    assert.match(mismatch!, /subagent-chat-/);
    // Matching intended passes.
    assert.equal(intendedMismatchReason("d", d, d, (s) => s.id.slice(0, 8)), null);

    // --- Scenario 3: delivery receipt label ---
    const receipt = formatTargetLabel(d, "d", (s) => s.id.slice(0, 8));
    assert.match(receipt, /^d \(/);
    assert.match(receipt, /\)$/);
    const unverified = formatTargetLabel(null, "stale-prefix", (s) => s.id.slice(0, 8));
    assert.match(unverified, /unverified/);

    // --- Scenario 4: identity-bound members are admitted by exact id ---
    const idBoundChannel = { name: "任务组", members: [{ name: "导师", role: "导师", id: e.id }, { name: "秘书", id: d.id }] };
    assert.equal(channelRejectsSession(idBoundChannel, e), null, "runtime alias admitted by bound id");
    assert.equal(channelRejectsSession(idBoundChannel, d), null, "member admitted by bound id");
    assert.match(channelRejectsSession(idBoundChannel, c)!, /is not a member/);
    // Dual binding: intended identity resolves to the exact bound session id.
    assert.equal(resolveBoundId(idBoundChannel, "导师"), e.id);
    assert.equal(resolveBoundId(idBoundChannel, "秘书"), d.id);
    assert.equal(resolveBoundId(idBoundChannel, "导师 "), e.id); // trimmed

    // --- Scenario 5: no channel file → behavior unchanged (backward compatible) ---
    const noGuard = await beta.send(alpha.sessionId!, { text: "no-channel direct" });
    assert.equal(noGuard.delivered, true, `direct delivery accepted: ${noGuard.reason ?? ""}`);
    await alphaIn.waitFor("no-channel direct");
  } finally {
    for (const client of clients) {
      await client.disconnect().catch(() => undefined);
    }
    if (broker) {
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    }
    rmSync(agentDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
});
