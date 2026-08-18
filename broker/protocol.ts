import type {
  Attachment,
  ChannelAddress,
  ChannelInfo,
  Message,
  MessageControl,
  MessageReceipt,
  MessageReceiptStatus,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageReceiptStatus(value: unknown): value is MessageReceiptStatus {
  return value === "receiver_received"
    || value === "queued"
    || value === "injected"
    || value === "acknowledged"
    || value === "expired"
    || value === "cancelled"
    || value === "superseded"
    || value === "cancellation_requested";
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || !isMessageReceiptStatus(value.status) || typeof value.timestamp !== "number") {
    return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

export function isMessageControl(value: unknown): value is MessageControl {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || typeof value.timestamp !== "number") {
    return false;
  }
  if (value.action !== "cancel" && value.action !== "supersede") {
    return false;
  }
  if (value.supersededBy !== undefined && typeof value.supersededBy !== "string") {
    return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

export function isChannelAddress(value: unknown): value is ChannelAddress {
  if (!isRecord(value)) return false;
  return typeof value.channelId === "string"
    && value.channelId.length > 0
    && typeof value.channelEpoch === "string"
    && value.channelEpoch.length > 0
    && typeof value.fromMemberId === "string"
    && value.fromMemberId.length > 0
    && typeof value.toMemberId === "string"
    && value.toMemberId.length > 0
    && value.fromMemberId !== value.toMemberId
    && typeof value.targetBindingEpoch === "string"
    && value.targetBindingEpoch.length > 0;
}

function isChannelMemberInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.memberId === "string"
    && value.memberId.length > 0
    && typeof value.agentName === "string"
    && value.agentName.trim().length > 0
    && Number.isSafeInteger(value.joinOrdinal)
    && Number(value.joinOrdinal) > 0
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.bindingEpoch === "string"
    && value.bindingEpoch.length > 0
    && (value.state === "online" || value.state === "offline" || value.state === "left")
    && Number.isSafeInteger(value.joinedAt)
    && Number.isSafeInteger(value.lastSeenAt);
}

export function isChannelInfo(value: unknown): value is ChannelInfo {
  if (!isRecord(value) || !Array.isArray(value.members) || value.members.length < 2) return false;
  if (!(value.members as unknown[]).every(isChannelMemberInfo)) return false;
  const memberIds = new Set((value.members as Array<Record<string, unknown>>).map((member) => member.memberId));
  const names = new Set((value.members as Array<Record<string, unknown>>).map((member) => String(member.agentName).toLowerCase()));
  if (memberIds.size !== value.members.length || names.size !== value.members.length) return false;
  return value.schemaVersion === 1
    && typeof value.channelId === "string"
    && value.channelId.length > 0
    && typeof value.epoch === "string"
    && value.epoch.length > 0
    && (value.lifecycle === "ephemeral" || value.lifecycle === "reusable")
    && (value.state === "active" || value.state === "closed" || value.state === "expired")
    && Number.isSafeInteger(value.createdAt)
    && Number.isSafeInteger(value.lastActivityAt)
    && (value.expiresAt === undefined || Number.isSafeInteger(value.expiresAt));
}

function isAttachment(value: unknown): value is Attachment {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !== "file"
    && value.type !== "snippet"
    && value.type !== "context"
  ) {
    return false;
  }

  if (typeof value.name !== "string" || typeof value.content !== "string") {
    return false;
  }

  return value.language === undefined || typeof value.language === "string";
}

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || typeof value.timestamp !== "number") {
    return false;
  }

  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.supersedes !== undefined && typeof value.supersedes !== "string") {
    return false;
  }

  if (value.retryOf !== undefined && typeof value.retryOf !== "string") {
    return false;
  }

  if (value.replyTo !== undefined && typeof value.replyTo !== "string") {
    return false;
  }

  if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") {
    return false;
  }

  if (value.channel !== undefined && !isChannelAddress(value.channel)) {
    return false;
  }
  for (const key of ["channelSenderName", "channelTargetName"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].trim().length === 0)) {
      return false;
    }
  }

  if (!isRecord(value.content) || typeof value.content.text !== "string") {
    return false;
  }

  return value.content.attachments === undefined
    || (Array.isArray(value.content.attachments) && value.content.attachments.every(isAttachment));
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string"
    || typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }

  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }

  if (value.status !== undefined && typeof value.status !== "string") {
    return false;
  }

  if (value.peerUid !== undefined && typeof value.peerUid !== "number") {
    return false;
  }

  for (const key of ["contextPct", "contextTokens", "contextWindow"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }

  return value.trustedLocal === undefined || typeof value.trustedLocal === "boolean";
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }
  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions)) {
    return false;
  }
  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }

  return value.status === undefined || typeof value.status === "string";
}
