import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_STATE_BYTES = 64 * 1024;

export interface StateEnvelope {
  formatVersion: 1;
  namespace: string;
  revision: number;
  updatedAt: number;
  payloadSha256: string;
  payload: unknown;
}

export interface StateCommitResult {
  committed: boolean;
  revision: number;
  reason?: string;
  payload?: unknown;
}

function serializePayload(payload: unknown): string | null {
  try {
    const json = JSON.stringify(payload);
    if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

function payloadHash(payloadJson: string): string {
  return createHash("sha256").update(payloadJson).digest("hex");
}

export class ExtensionStateManager {
  private readonly states = new Map<string, { revision: number; payload: unknown }>();
  private readonly stateDir: string;

  constructor(runtimeDir: string) {
    this.stateDir = join(runtimeDir, "extension-state");
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  private statePath(namespace: string): string {
    const hash = createHash("sha256").update(namespace).digest("hex");
    return join(this.stateDir, `${hash}.json`);
  }

  private backupPath(namespace: string): string {
    return `${this.statePath(namespace)}.bak`;
  }

  private readEnvelope(filePath: string, namespace: string): StateEnvelope | null {
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, "utf8");
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;

      const envelope = value as Record<string, unknown>;
      if (
        envelope.formatVersion !== 1
        || envelope.namespace !== namespace
        || !Number.isSafeInteger(envelope.revision)
        || (envelope.revision as number) < 0
        || typeof envelope.updatedAt !== "number"
        || typeof envelope.payloadSha256 !== "string"
      ) {
        return null;
      }

      const payloadJson = serializePayload(envelope.payload);
      if (payloadJson === null || payloadHash(payloadJson) !== envelope.payloadSha256) {
        return null;
      }

      return envelope as unknown as StateEnvelope;
    } catch {
      return null;
    }
  }

  loadState(namespace: string): { revision: number; payload: unknown } | null {
    const cached = this.states.get(namespace);
    if (cached) return cached;

    const envelope = this.readEnvelope(this.statePath(namespace), namespace)
      ?? this.readEnvelope(this.backupPath(namespace), namespace);
    if (!envelope) return null;

    const state = { revision: envelope.revision, payload: envelope.payload };
    this.states.set(namespace, state);
    return state;
  }

  commitState(namespace: string, expectedRevision: number, payload: unknown): StateCommitResult {
    const payloadJson = serializePayload(payload);
    const current = this.loadState(namespace);
    const currentRevision = current?.revision ?? 0;

    if (payloadJson === null) {
      return {
        committed: false,
        revision: currentRevision,
        reason: "Invalid extension state or payload exceeds 64 KiB limit",
      };
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { committed: false, revision: currentRevision, reason: "Invalid expected revision" };
    }
    if (expectedRevision !== currentRevision) {
      return {
        committed: false,
        revision: currentRevision,
        reason: "Revision mismatch",
        ...(current ? { payload: current.payload } : {}),
      };
    }

    const envelope: StateEnvelope = {
      formatVersion: 1,
      namespace,
      revision: currentRevision + 1,
      updatedAt: Date.now(),
      payloadSha256: payloadHash(payloadJson),
      payload,
    };
    const statePath = this.statePath(namespace);
    const backupPath = this.backupPath(namespace);
    const tempPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;

    try {
      writeFileSync(tempPath, JSON.stringify(envelope), { mode: 0o600 });
      const file = openSync(tempPath, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }

      if (this.readEnvelope(statePath, namespace)) {
        copyFileSync(statePath, backupPath);
      }
      renameSync(tempPath, statePath);

      try {
        const directory = openSync(dirname(statePath), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } catch {
        // Directory fsync is unavailable on some platforms.
      }

      const state = { revision: envelope.revision, payload };
      this.states.set(namespace, state);
      return { committed: true, revision: envelope.revision };
    } catch {
      return { committed: false, revision: currentRevision, reason: "Failed to persist extension state" };
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  getCurrentRevision(namespace: string): number {
    return this.loadState(namespace)?.revision ?? 0;
  }
}
