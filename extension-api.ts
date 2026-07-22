import type { SessionInfo } from "./types.ts";

export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

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
