import type { SessionInfo } from "./types.ts";

export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

/**
 * General "send as the current session" channel.
 *
 * Any extension can emit INTERCOM_EXTENSION_SEND_EVENT on the pi event bus
 * with { to, message, requestId? }. pi-intercom (running in the same process)
 * forwards the message through the CURRENT session's own intercom client, so
 * the broker records the message's `from` as this session — preserving sender
 * identity and letting replies route back natively. If `requestId` is provided,
 * pi-intercom emits INTERCOM_EXTENSION_SEND_RESULT_EVENT with the delivery
 * outcome so the caller can confirm the message landed instead of assuming it.
 *
 * This is the right primitive for an extension that needs to deliver a message
 * to another agent on the caller's behalf without the caller's own agent having
 * to place the intercom send itself.
 */
export const INTERCOM_EXTENSION_SEND_EVENT = "intercom:extension-send";
export const INTERCOM_EXTENSION_SEND_RESULT_EVENT = "intercom:extension-send-result";

export interface IntercomExtensionSendRequest {
  /** Target intercom session id or name. */
  to: string;
  /** Plain-text message body to deliver. */
  message: string;
  /** If provided, a matching result event is emitted on the pi event bus. */
  requestId?: string;
}

export interface IntercomExtensionSendResult {
  requestId?: string;
  delivered: boolean;
  reason?: string;
}

export interface IntercomExtensionOwner {
  sessionId: string;
  epoch: string;
}

export interface IntercomExtensionState {
  revision: number;
  payload: unknown;
}

export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: IntercomExtensionOwner }
  | { type: "message"; fromSessionId: string; owner?: IntercomExtensionOwner; payload: unknown }
  | { type: "state"; state: IntercomExtensionState }
  | { type: "state_result"; committed: boolean; revision: number; reason?: string }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo };

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: IntercomExtensionOwner;
    state?: IntercomExtensionState;
  };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  commitState(payload: unknown, expectedRevision?: number): void;
  listSessions(): Promise<SessionInfo[]>;
}

export interface IntercomExtensionRegistration {
  namespace: string;
  ownerEligible: boolean;
  onEvent(event: IntercomExtensionEvent): void;
  onReady(channel: IntercomExtensionChannel): void;
}
