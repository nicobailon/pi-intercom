import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Fixed-channel membership for intercom send/ask.
 *
 * A project opts into a fixed channel by placing `.pi/intercom-channel.json`
 * somewhere above the session's cwd (the file is discovered by walking up
 * parent directories). When a channel file exists, send/ask targets must
 * resolve to one of the listed members — a message to a non-member is refused
 * before it is delivered. This makes "sent to a session outside the task"
 * structurally impossible instead of merely detectable.
 *
 * Example `.pi/intercom-channel.json`:
 * {
 *   "name": "R-ICL 任务组",
 *   "members": [
 *     { "name": "eng-lead", "role": "发起者" },
 *     { "name": "executor", "role": "接受者", "id": "01a0…" }
 *   ]
 * }
 * Members match by session name (case-insensitive) and/or by exact session id.
 * An `id` binds the member to a specific session so a runtime alias that has
 * not been `/name`d can still be admitted.
 */

export const CHANNEL_FILE_NAME = "intercom-channel.json";

export interface ChannelMember {
  name?: string;
  role?: string;
  id?: string;
}

export interface ChannelConfig {
  name: string;
  members: ChannelMember[];
}

export interface SessionLike {
  id: string;
  name?: string | null;
  /** True when `name` is an automatically generated runtime alias, not a user identity. */
  runtimeFallbackAlias?: boolean;
}

/** Walk up from startDir looking for `<dir>/.pi/intercom-channel.json`. */
export function findChannelFile(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".pi", CHANNEL_FILE_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function loadChannel(file: string): ChannelConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid channel file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid channel file ${file}: expected a JSON object.`);
  }
  const cfg = raw as Record<string, unknown>;
  if (typeof cfg.name !== "string" || cfg.name.trim().length === 0) {
    throw new Error(`Invalid channel file ${file}: missing non-empty "name" string.`);
  }
  if (!Array.isArray(cfg.members) || cfg.members.length === 0) {
    throw new Error(`Invalid channel file ${file}: missing non-empty "members" array.`);
  }
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const members: ChannelMember[] = cfg.members.map((member, index) => {
    if (typeof member !== "object" || member === null) {
      throw new Error(`Invalid channel file ${file}: members[${index}] must be an object.`);
    }
    const m = member as Record<string, unknown>;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (name.length === 0 && id.length === 0) {
      throw new Error(`Invalid channel file ${file}: members[${index}] needs a non-empty "name" and/or "id".`);
    }
    if (name.length > 0) {
      const key = name.toLowerCase();
      if (seenNames.has(key)) throw new Error(`Invalid channel file ${file}: duplicate member name "${name}".`);
      seenNames.add(key);
    }
    if (id.length > 0) {
      if (seenIds.has(id)) throw new Error(`Invalid channel file ${file}: duplicate member id "${id}".`);
      seenIds.add(id);
    }
    return {
      ...(name.length > 0 ? { name } : {}),
      ...(id.length > 0 ? { id } : {}),
      ...(typeof m.role === "string" && m.role.trim().length > 0 ? { role: m.role } : {}),
    };
  });
  return { name: cfg.name, members };
}

/** Human-readable member list, e.g. `a (发起者), b (接受者)`. */
export function formatChannelMembers(config: ChannelConfig): string {
  return config.members
    .map((member) => {
      const label = member.name ?? member.id ?? "<unnamed>";
      return member.role ? `${label} (${member.role})` : label;
    })
    .join(", ");
}

/**
 * Returns the channel member a session matches.
 *
 * An id-bearing member is bound to the exact runtime endpoint. Its `name` is
 * the channel-local logical identity (and need not equal the session's
 * mutable display name). A same-name session with a different id is rejected.
 * Name-only members are supported for legacy channel files, but generated
 * runtime aliases never satisfy a name-only binding because an alias is not a
 * user identity.
 */
export function channelMemberFor(
  config: ChannelConfig,
  session: SessionLike | null | undefined,
): ChannelMember | null {
  if (!session) {
    return null;
  }
  const name = (session.name ?? "").trim().toLowerCase();
  for (const member of config.members) {
    const memberName = member.name?.trim().toLowerCase();
    const nameMatches = Boolean(memberName && name && memberName === name && !session.runtimeFallbackAlias);
    if (member.id) {
      if (member.id === session.id) return member;
      continue;
    }
    if (nameMatches) {
      return member;
    }
  }
  return null;
}

/**
 * Returns null when `session` is allowed to receive messages in the channel,
 * otherwise a rejection reason. ID-bearing members require exact ID; name-only
 * members are a legacy weaker binding.
 */
export function channelRejectsSession(
  config: ChannelConfig,
  session: SessionLike | null | undefined,
): string | null {
  const members = formatChannelMembers(config);
  if (!session) {
    return `Channel "${config.name}" restricts recipients to its members (${members}); the target could not be resolved to a connected session.`;
  }
  if (channelMemberFor(config, session)) {
    return null;
  }
  const label = session.name ?? session.id;
  return `Channel "${config.name}" restricts recipients to its members (${members}). "${label}" is not a member.`;
}

/**
 * Identity binding: look up the session id that an identity name is bound to.
 * Returns null when the name is not a member identity or the member has no id.
 * This is the strict half of the dual binding — when the caller declares an
 * intended recipient by identity ("导师"), the delivery target must be the
 * exact session the channel binds that identity to, so a lookalike session
 * that merely /name's itself after a role cannot intercept traffic.
 */
export function resolveBoundId(config: ChannelConfig, identityName: string): string | null {
  const target = identityName.trim().toLowerCase();
  const member = config.members.find((m) => m.name !== undefined && m.name.trim().toLowerCase() === target);
  return member?.id ?? null;
}

/**
 * Declared-recipient check: the caller states who they *intend* to reach
 * (`intended`) and the tool refuses to deliver when the resolved target is a
 * different session. Returns null when intended matches, otherwise a rejection
 * reason. `shortId` for a session is only used in the error text.
 */
export function intendedMismatchReason(
  intended: string,
  intendedSession: SessionLike | null | undefined,
  targetSession: SessionLike | null | undefined,
  shortIdFor: (session: SessionLike) => string,
): string | null {
  if (!intendedSession) {
    return `intended "${intended}" did not resolve to any connected session; declare the exact name or the short id shown by "list".`;
  }
  const targetName = targetSession?.name ? `"${targetSession.name}"` : `id ${targetSession?.id ?? "<unresolved>"}`;
  if (!targetSession) {
    return `intended recipient is ${describeSession(intendedSession, shortIdFor)} but the target ${targetName} is not a connected session.`;
  }
  if (intendedSession.id === targetSession.id) {
    return null;
  }
  return `Refusing to send: resolved target is ${describeSession(targetSession, shortIdFor)} but intended recipient is ${describeSession(intendedSession, shortIdFor)}. Make to/intended match, or drop intended.`;
}

function describeSession(session: SessionLike, shortIdFor: (session: SessionLike) => string): string {
  const label = session.name ? `"${session.name}"` : session.id;
  return `${label} (${shortIdFor(session)})`;
}

/**
 * Delivery-receipt label for a resolved target, e.g. `c (a1b2c3d4)`. When the
 * member resolved through a channel, `identityLabel` (the member's identity
 * name, e.g. 导师) takes precedence over the raw session name so receipts
 * show who the sender meant, not the runtime alias.
 * When the target could not be matched to a connected session, the fallback
 * is kept with an explicit unverified marker so the sender can see that the
 * address was used as-is.
 */
export function formatTargetLabel(
  targetSession: SessionLike | null | undefined,
  fallback: string,
  shortIdFor: (session: SessionLike) => string,
  identityLabel?: string,
): string {
  if (!targetSession) {
    return `${fallback} (unverified: not in the connected session list)`;
  }
  const name = identityLabel ?? targetSession.name ?? targetSession.id;
  return `${name} (${shortIdFor(targetSession)})`;
}
