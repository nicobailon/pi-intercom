export const EXTENSION_BUS_FEATURE = "extension-bus-v1";
/** Broker-enforced logical channels for conversational delivery. */
export const CHANNEL_BUS_FEATURE = "channel-v1";

export type ChannelLifecycle = "ephemeral" | "reusable";
export type ChannelState = "active" | "closed" | "expired";
export type ChannelMemberState = "online" | "offline" | "left";

/** Stable logical identity inside a channel; sessionId is only the current endpoint. */
export interface ChannelMemberInfo {
  memberId: string;
  agentName: string;
  joinOrdinal: number;
  sessionId: string;
  bindingEpoch: string;
  state: ChannelMemberState;
  joinedAt: number;
  lastSeenAt: number;
}

export interface ChannelInfo {
  schemaVersion: 1;
  channelId: string;
  epoch: string;
  lifecycle: ChannelLifecycle;
  state: ChannelState;
  createdAt: number;
  lastActivityAt: number;
  expiresAt?: number;
  members: ChannelMemberInfo[];
}

/** Every channel message has one sender member and exactly one target member. */
export interface ChannelAddress {
  channelId: string;
  channelEpoch: string;
  fromMemberId: string;
  toMemberId: string;
  targetBindingEpoch: string;
}

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface SessionInfo {
  id: string;
  name?: string;
  /** True only when the extension synthesized name for an unnamed runtime. */
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  /** Live context-window usage, pushed via presence from the source session's
   *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
   *  contextWindow are raw token counts. All optional: unknown right after a
   *  compaction (before the next assistant response), when no model is selected,
   *  or on older clients that never report it. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** tmux pane id (e.g. "%212") of the session's terminal, read from
   *  $TMUX_PANE at registration. Present only when the session runs inside a
   *  tmux pane; absent for cloud, headless, IDE-embedded, or Herdr sessions.
   *  The pane id is immutable for the process lifetime — unlike the window
   *  name, which is mutable — so a peer can live-resolve the current window
   *  from it via tmux when it needs to introspect or drive that pane. */
  tmuxPane?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  /** Present on all broker-enforced conversational messages. */
  channel?: ChannelAddress;
  /** Broker-resolved channel-local identities for model-visible diagnostics. */
  channelSenderName?: string;
  channelTargetName?: string;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal"> & {
  extensions?: ExtensionCapability[];
};

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string }
  | { type: "unregister" }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string }
  | { type: "channel_open"; requestId: string; targetSessionId: string; lifecycle?: ChannelLifecycle }
  | { type: "channel_close"; requestId: string; channelId: string; channelEpoch: string }
  | { type: "channel_send"; channel: ChannelAddress; message: Message }
  /** Legacy wire form. The broker only accepts an exact session ID and upgrades it to a channel. */
  | { type: "send"; to: string; message: Message }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "channel_opened"; requestId: string; channel: ChannelInfo; selfMemberId: string; targetMemberId: string }
  | { type: "channel_closed"; requestId: string; channelId: string }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; state?: DeliveryState; channelId?: string }
  | {
      type: "delivery_failed";
      messageId: string;
      reason: string;
      code?: string;
      retryable?: boolean;
      outcomeKnown?: boolean;
      channelId?: string;
    }
  | { type: "channel_open_failed"; requestId: string; reason: string; code?: string; retryable?: boolean }
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };
