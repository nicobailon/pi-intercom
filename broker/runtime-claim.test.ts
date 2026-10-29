import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertNoLiveBroker } from "./runtime-claim.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { INTERCOM_PROTOCOL_NAME, INTERCOM_PROTOCOL_VERSION } from "./paths.ts";

function endpointIn(directory: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-intercom-test-${path.basename(directory)}`
    : path.join(directory, "broker.sock");
}

function listenAsBroker(endpoint: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("data", createMessageReader((message) => {
      const { requestId } = message as { requestId: string };
      writeMessage(socket, {
        type: "health_ok",
        requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
      });
    }, () => socket.destroy()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("broker startup refuses to replace a live broker that owns the endpoint", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  const endpoint = endpointIn(directory);
  const server = await listenAsBroker(endpoint);
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    await assert.rejects(
      assertNoLiveBroker(pidPath, () => endpoint),
      new RegExp(`Refusing to replace live intercom broker process ${process.pid}`),
    );
  } finally {
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup ignores a PID that now belongs to a process without the broker endpoint", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(sleeper.pid);
    writeFileSync(pidPath, `${sleeper.pid}\n`);
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpointIn(directory)));
  } finally {
    sleeper.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup ignores a live PID whose endpoint is owned by something that is not a broker", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  const endpoint = endpointIn(directory);
  const impostor = net.createServer((socket) => {
    socket.resume();
    socket.end();
  });
  await new Promise<void>((resolve) => impostor.listen(endpoint, resolve));
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpoint));
  } finally {
    await closeServer(impostor);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup ignores a live PID when the endpoint record cannot be read", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => {
      throw new Error("missing endpoint file");
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup tolerates absent, invalid, and stale PID files", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  const endpoint = endpointIn(directory);
  try {
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpoint));
    writeFileSync(pidPath, "invalid\n");
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpoint));
    writeFileSync(pidPath, "2147483647\n");
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpoint));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup ignores a PID file pointing at another user's process", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    // pid 1 is owned by root, so signal 0 from a non-root user fails with EPERM.
    writeFileSync(pidPath, "1\n");
    await assert.doesNotReject(assertNoLiveBroker(pidPath, () => endpointIn(directory)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
