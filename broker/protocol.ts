import type {
  Attachment,
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

  if (value.endpointEpoch !== undefined && typeof value.endpointEpoch !== "string") {
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
