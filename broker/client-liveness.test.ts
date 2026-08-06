import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { IntercomClient } from "./client.ts";
import { writeMessage } from "./framing.ts";

/**
 * Unit tests for the half-open socket fix.
 *
 * Bug: when the broker dies without sending a FIN (SIGKILL, crash, host loss),
 * the client's socket stays "writable" indefinitely. isConnected() keeps
 * returning true, no "disconnected" event fires, and the extension's
 * scheduleReconnect() is never called — so the agent silently drops out of the
 * intercom roster forever (this is why long-lived headless/RPC pi agents
 * vanish from `intercom list` after a broker restart).
 *
 * The fix: (1) a socket "error" after registration destroys the socket so the
 * existing onClose -> "disconnected" path runs, and (2) a liveness heartbeat
 * that round-trips a lightweight request and tears down the socket on timeout
 * or write error, so a half-open connection is detected within a bounded
 * window even when the OS never delivers an error.
 */

const homeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-liveness-unit-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = "100";
process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS = "200";

test.after(() => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  rmSync(homeDir, { recursive: true, force: true });
});

/**
 * Build a registered IntercomClient wired to a fake server socket pair, so we
 * can simulate a half-open connection without spawning a real broker.
 */
async function registeredClientAgainstFakeSocket(): Promise<{
  client: IntercomClient;
  serverSide: net.Socket;
  closeServerSideAbruptly(): void;
  stopResponding(): void;
}> {
  const { getBrokerSocketPath } = await import("./paths.ts");
  const { mkdirSync, unlinkSync } = await import("node:fs");
  const socketPath = getBrokerSocketPath();
  const intercomDir = path.dirname(socketPath);
  mkdirSync(intercomDir, { recursive: true });
  try { unlinkSync(socketPath); } catch { /* no stale socket */ }

  const client = new IntercomClient();
  let resolveReady: (value: { serverSide: net.Socket; closeServerSideAbruptly(): void; stopResponding(): void }) => void;
  let rejectReady: (reason: unknown) => void;
  const ready = new Promise<{ serverSide: net.Socket; closeServerSideAbruptly(): void; stopResponding(): void }>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let responding = true;
  const server = net.createServer((serverSide) => {
    serverSide.on("data", (data) => {
      if (!responding) return; // simulate a dead/unresponsive broker: drop everything
      try {
        const len = data.readUInt32BE(0);
        const json = JSON.parse(data.subarray(4, 4 + len).toString("utf-8"));
        if (json.type === "register") {
          writeMessage(serverSide, { type: "registered", sessionId: json.sessionId ?? "stable-test", features: [] });
        }
        if (json.type === "list") {
          writeMessage(serverSide, { type: "sessions", requestId: json.requestId, sessions: [] });
        }
      } catch {
        // ignore parse errors in the fake
      }
    });
    server.close();
    resolveReady({
      serverSide,
      closeServerSideAbruptly() {
        // Destroy WITHOUT a clean FIN — simulates a SIGKILL'd broker peer.
        serverSide.destroy();
      },
      stopResponding() {
        // Simulate a half-open socket: the peer stops reading/replying but the
        // connection is not closed, so no "close"/"error" event reaches the
        // client. Only an active liveness probe can detect this.
        responding = false;
      },
    });
  });
  server.on("error", (err) => rejectReady(err));
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  await client.connect(
    {
      name: "liveness-unit",
      cwd: homeDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    },
    "stable-liveness-unit",
  );
  const { serverSide, closeServerSideAbruptly, stopResponding } = await ready;
  return { client, serverSide, closeServerSideAbruptly, stopResponding };
}

test("client emits disconnected when the peer destroys the socket without a FIN", async () => {
  const { client, closeServerSideAbruptly } = await registeredClientAgainstFakeSocket();
  try {
    assert.equal(client.isConnected(), true, "client should be connected after register");

    const disconnected = once(client, "disconnected");
    closeServerSideAbruptly();

    const event = await Promise.race([
      disconnected,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("client never noticed the abruptly-closed peer (half-open socket)")),
          3000,
        ),
      ),
    ]);
    assert.ok(event, "expected a disconnected event");
    assert.equal(client.isConnected(), false);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
});

test("client liveness heartbeat detects a half-open socket within a bounded window", async () => {
  const { client, stopResponding } = await registeredClientAgainstFakeSocket();
  try {
    assert.equal(client.isConnected(), true);

    const disconnected = once(client, "disconnected");
    // Simulate a half-open socket: the peer stops replying but does NOT close
    // the connection. No "close"/"error" event reaches the client, so passive
    // detection cannot fire — only the liveness heartbeat can notice.
    stopResponding();

    // The heartbeat (interval ~100ms, timeout ~200ms) must notice and tear down.
    const event = await Promise.race([
      disconnected,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("liveness heartbeat did not detect the half-open socket within 3s")),
          3000,
        ),
      ),
    ]);
    assert.ok(event, "expected the heartbeat to surface a disconnected event");
    assert.equal(client.isConnected(), false);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
});