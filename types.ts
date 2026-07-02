export interface SessionInfo {
  id: string;
  name?: string;
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
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
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

export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal">;

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "cancel_ask"; messageId: string }
  // presence carries optional context-usage fields so peers see each session's
  // live context% without a separate query. contextPct/contextTokens/contextWindow
  // accept null as an explicit CLEAR signal (post-compaction the value is unknown
  // until the next assistant response); the broker deletes the field rather than
  // carrying the stale value forward.
  | { type: "presence"; name?: string; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
