import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test } from "node:test";

interface Registration {
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writes: Buffer[] = [];

  write(chunk: Uint8Array | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.writable = false;
    this.writableEnded = true;
    return this;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

function registration(): Registration {
  return {
    cwd: process.cwd(),
    model: "test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

test("connect keeps a guard for late socket errors after cleanup", async () => {
  const originalConnect = net.connect;
  let socket: FakeSocket | undefined;

  try {
    (net as typeof net & { connect: () => FakeSocket }).connect = () => {
      socket = new FakeSocket();
      return socket;
    };

    const { IntercomClient } = await import("./client.ts");
    const client = new IntercomClient();
    const firstError = Object.assign(new Error("first reset"), { code: "ECONNRESET" });
    const lateError = Object.assign(new Error("late reset"), { code: "ECONNRESET" });

    const connectPromise = client.connect(registration()).catch((error: Error) => error);
    assert.ok(socket);

    socket.emit("error", firstError);
    assert.equal((await connectPromise).message, "first reset");
    assert.equal(socket.destroyed, true);
    assert.equal(socket.listenerCount("error"), 1);

    assert.doesNotThrow(() => socket?.emit("error", lateError));
  } finally {
    (net as typeof net & { connect: typeof originalConnect }).connect = originalConnect;
  }
});
