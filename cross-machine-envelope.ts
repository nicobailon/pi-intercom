import type { CrossMachineOrigin } from "./types.ts";

export type { CrossMachineOrigin } from "./types.ts";

export interface CrossMachineEnvelope {
  version: 1;
  target: string;
  text: string;
  origin: CrossMachineOrigin;
  trust: "ssh-asserted";
}

export const MAX_RELAY_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_RELAY_TARGET_BYTES = 1024;
export const MAX_RELAY_TEXT_BYTES = 256 * 1024;
export const MAX_RELAY_ORIGIN_FIELD_BYTES = 1024;

const ENVELOPE_FIELDS = ["origin", "target", "text", "trust", "version"];
const ORIGIN_FIELDS = ["machine", "name", "sessionId"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && keys.every((key, index) => key === fields[index]);
}

function isNonBlankWithinBytes(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function defaultMachineName(host: string): string {
  return host.split(".", 1)[0]!.toLowerCase();
}

export function resolveOrigin(
  sessions: Array<{ id: string; name?: string; runtimeFallbackAlias?: boolean }>,
  fallbackName: string,
  machineName: string,
  excludeSessionId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): CrossMachineOrigin {
  const envSessionId = env.PI_INTERCOM_SESSION_ID?.trim() || env.PI_SESSION_ID?.trim();
  const matches = envSessionId
    ? sessions.filter((session) => session.id === envSessionId)
    : sessions.filter((session) => session.id !== excludeSessionId && !session.runtimeFallbackAlias && session.name?.toLowerCase() === fallbackName.toLowerCase());
  if (matches.length > 1) {
    throw new Error(`Multiple sessions match cross-machine origin "${fallbackName}". Set PI_INTERCOM_SESSION_ID to the source session ID.`);
  }
  const source = matches[0];
  return {
    name: source?.name?.trim() || fallbackName,
    sessionId: source?.id || envSessionId || "unknown",
    machine: machineName,
  };
}

export function parseRelayEnvelope(raw: string): CrossMachineEnvelope {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RELAY_ENVELOPE_BYTES) {
    throw new Error(`Cross-machine relay envelope exceeds ${MAX_RELAY_ENVELOPE_BYTES} byte limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid cross-machine relay envelope JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Invalid cross-machine relay envelope.");
  }
  if (value.version !== 1) {
    throw new Error("Unsupported cross-machine relay envelope version; upgrade pi-intercom on both machines.");
  }
  if (value.trust !== "ssh-asserted") {
    throw new Error("Unsupported cross-machine relay envelope trust.");
  }
  if (!hasExactlyFields(value, ENVELOPE_FIELDS) || !isNonBlankWithinBytes(value.target, MAX_RELAY_TARGET_BYTES)
    || typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > MAX_RELAY_TEXT_BYTES || !isRecord(value.origin)
    || !hasExactlyFields(value.origin, ORIGIN_FIELDS)
    || !isNonBlankWithinBytes(value.origin.name, MAX_RELAY_ORIGIN_FIELD_BYTES)
    || !isNonBlankWithinBytes(value.origin.sessionId, MAX_RELAY_ORIGIN_FIELD_BYTES)
    || !isNonBlankWithinBytes(value.origin.machine, MAX_RELAY_ORIGIN_FIELD_BYTES)) {
    throw new Error("Invalid cross-machine relay envelope.");
  }
  return value as unknown as CrossMachineEnvelope;
}

export function relaySenderName(origin: Pick<CrossMachineOrigin, "name" | "machine">): string {
  return `${origin.name}@${origin.machine}`;
}

export function relayMessage(envelope: CrossMachineEnvelope): string {
  return `[Unverified cross-machine origin]\n${envelope.text}`;
}
