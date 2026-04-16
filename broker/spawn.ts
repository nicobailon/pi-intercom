// broker/spawn.ts
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import net from "net";
import { getBrokerSocketPath } from "./paths.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SOCKET = getBrokerSocketPath();
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getTsxCliPath(extensionDir: string = EXTENSION_DIR): string {
  return join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  extensionDir: string = EXTENSION_DIR,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [getTsxCliPath(extensionDir), brokerPath],
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(): Promise<void> {
  mkdirSync(INTERCOM_DIR, { recursive: true });

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
    const launch = getBrokerLaunchSpec(brokerPath);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        reject(toError(error));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  if (!existsSync(BROKER_PID)) return false;

  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    process.kill(pid, 0); // Check if process exists (signal 0 = no signal, just check)
    
    // Also verify socket is accepting connections
    return checkSocketConnectable();
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

function checkSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(BROKER_SOCKET);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(isConnected);
    };
    const onConnect = () => {
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    // Timeout after 1 second
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      // Lock exists and is not stale - another process owns it
      return false;
    }
  }
  // Couldn't acquire lock after max retries (stale lock that can't be deleted)
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
