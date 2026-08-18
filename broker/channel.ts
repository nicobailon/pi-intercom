import { randomUUID } from "node:crypto";
import type {
  ChannelAddress,
  ChannelInfo,
  ChannelLifecycle,
  ChannelMemberInfo,
  SessionInfo,
} from "../types.ts";

export const DEFAULT_EPHEMERAL_CHANNEL_TTL_MS = 30 * 60 * 1000;
export const CHANNEL_STATE_FILE_VERSION = 1;

function ephemeralChannelTtlMs(): number {
  const configured = Number.parseInt(process.env.PI_INTERCOM_EPHEMERAL_CHANNEL_TTL_MS ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_EPHEMERAL_CHANNEL_TTL_MS;
}

export function cloneChannel(channel: ChannelInfo): ChannelInfo {
  return {
    ...channel,
    members: channel.members.map((member) => ({ ...member })),
  };
}

export function channelMemberById(channel: ChannelInfo, memberId: string): ChannelMemberInfo | undefined {
  return channel.members.find((member) => member.memberId === memberId);
}

export function channelMemberForSession(channel: ChannelInfo, sessionId: string): ChannelMemberInfo | undefined {
  return channel.members.find((member) => member.sessionId === sessionId && member.state !== "left");
}

export function channelForPair(
  channels: Iterable<ChannelInfo>,
  firstSessionId: string,
  secondSessionId: string,
): ChannelInfo | undefined {
  return [...channels].find((channel) => {
    if (channel.state !== "active") return false;
    const first = channelMemberForSession(channel, firstSessionId);
    const second = channelMemberForSession(channel, secondSessionId);
    return Boolean(first && second && first.memberId !== second.memberId);
  });
}

export function channelNameForSession(session: SessionInfo, ordinal: number): string {
  const explicitName = session.runtimeFallbackAlias ? "" : session.name?.trim() ?? "";
  return explicitName || `执行者-${ordinal}`;
}

export function allocateChannelMember(
  channel: Pick<ChannelInfo, "members">,
  session: SessionInfo,
  joinOrdinal: number,
  now = Date.now(),
): ChannelMemberInfo {
  const usedNames = new Set(channel.members.map((member) => member.agentName.toLocaleLowerCase()));
  let agentName = channelNameForSession(session, joinOrdinal);
  if (usedNames.has(agentName.toLocaleLowerCase())) {
    if (session.runtimeFallbackAlias || !session.name?.trim()) {
      // Explicit names reserve their spelling; unnamed members skip a colliding
      // generated label while retaining their monotonically increasing ordinal.
      let suffix = joinOrdinal;
      do {
        suffix += 1;
        agentName = `执行者-${suffix}`;
      } while (usedNames.has(agentName.toLocaleLowerCase()));
    } else {
      throw new Error(`E_NAME_CONFLICT: agent name "${agentName}" is already used in this channel`);
    }
  }

  return {
    memberId: randomUUID(),
    agentName,
    joinOrdinal,
    sessionId: session.id,
    bindingEpoch: randomUUID(),
    state: "online",
    joinedAt: now,
    lastSeenAt: now,
  };
}

export function createPairChannel(
  sender: SessionInfo,
  target: SessionInfo,
  lifecycle: ChannelLifecycle = "ephemeral",
  now = Date.now(),
): ChannelInfo {
  const channel: ChannelInfo = {
    schemaVersion: 1,
    channelId: randomUUID(),
    epoch: randomUUID(),
    lifecycle,
    state: "active",
    createdAt: now,
    lastActivityAt: now,
    ...(lifecycle === "ephemeral" ? { expiresAt: now + ephemeralChannelTtlMs() } : {}),
    members: [],
  };
  channel.members.push(allocateChannelMember(channel, sender, 1, now));
  channel.members.push(allocateChannelMember(channel, target, 2, now));
  return channel;
}

export function channelAddress(
  channel: ChannelInfo,
  fromMember: ChannelMemberInfo,
  toMember: ChannelMemberInfo,
): ChannelAddress {
  return {
    channelId: channel.channelId,
    channelEpoch: channel.epoch,
    fromMemberId: fromMember.memberId,
    toMemberId: toMember.memberId,
    targetBindingEpoch: toMember.bindingEpoch,
  };
}

export function touchChannel(channel: ChannelInfo, now = Date.now()): void {
  channel.lastActivityAt = now;
  if (channel.lifecycle === "ephemeral") {
    channel.expiresAt = now + ephemeralChannelTtlMs();
  }
}

export function isChannelExpired(channel: ChannelInfo, now = Date.now()): boolean {
  return channel.state === "expired"
    || (channel.state === "active" && channel.expiresAt !== undefined && channel.expiresAt <= now);
}
