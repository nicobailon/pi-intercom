import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerConnectTarget, type BrokerConnectTarget } from "./paths.ts";
import { channelMemberFor, channelRejectsSession, findChannelFile, loadChannel, resolveBoundId } from "../channel.ts";
import { isChannelInfo, isMessage, isMessageControl, isMessageReceipt, isSessionInfo } from "./protocol.ts";
import { CHANNEL_BUS_FEATURE, EXTENSION_BUS_FEATURE } from "../types.ts";
import type {
  Attachment,
  BrokerMessage,
  ChannelInfo,
  ChannelLifecycle,
  ChannelAddress,
  ClientMessage,
  DeliveryState,
  Message,
  MessageControl,
  MessageReceipt,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
  supersedes?: string;
  retryOf?: string;
  /** Optional declared identity; static project channel policy verifies it. */
  intended?: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  state?: DeliveryState;
  reason?: string;
  code?: string;
  retryable?: boolean;
  outcomeKnown?: boolean;
  channelId?: string;
}

export interface ChannelBinding {
  channel: ChannelInfo;
  selfMemberId: string;
  targetMemberId: string;
  targetSessionId: string;
}

interface PendingChannelOpen {
  resolve: (binding: ChannelBinding) => void;
  reject: (error: Error) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Liveness heartbeat interval. A half-open socket (peer killed with SIGKILL or
 * crashed without sending a FIN) stays "writable" indefinitely, so passive
 * close-event detection never fires and the client silently drops out of the
 * roster. The heartbeat actively round-trips a lightweight request and tears
 * down the socket if the broker does not respond within the timeout, letting
 * the existing onClose -> "disconnected" path drive reconnection.
 */
function getLivenessIntervalMs(): number {
  const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function getLivenessTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, getLivenessIntervalMs()) : 5_000;
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private _features = new Set<string>();
  private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private pendingChannelOpens = new Map<string, PendingChannelOpen>();
  private pendingChannelCloses = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private channelBindings = new Map<string, ChannelBinding>();
  private registration: SessionRegistration | null = null;
  private nextSenderSequence = 1;
  private disconnecting = false;
  private disconnectError: Error | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private livenessInFlight = false;

  private failPending(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingChannelOpens.values()) {
      pending.reject(error);
    }
    this.pendingChannelOpens.clear();
    for (const pending of this.pendingChannelCloses.values()) {
      pending.reject(error);
    }
    this.pendingChannelCloses.clear();
    this.channelBindings.clear();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  supportsFeature(feature: string): boolean {
    return this._features.has(feature);
  }

  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  /**
   * Start the liveness heartbeat. Must be called once the connection is
   * registered. The heartbeat periodically round-trips a lightweight list
   * request and tears down the socket if the broker does not respond within
   * the liveness timeout, so a half-open connection is detected within a
   * bounded window instead of silently lingering forever.
   */
  private startLivenessHeartbeat(): void {
    this.stopLivenessHeartbeat();
    this.livenessTimer = setInterval(() => {
      this.runLivenessProbe();
    }, getLivenessIntervalMs());
    this.livenessTimer.unref?.();
  }

  private stopLivenessHeartbeat(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    this.livenessInFlight = false;
  }

  private async runLivenessProbe(): Promise<void> {
    if (this.livenessInFlight || !this.isConnected()) {
      return;
    }
    this.livenessInFlight = true;
    try {
      await this.listSessions({ timeoutMs: getLivenessTimeoutMs() });
    } catch (error) {
      // A timeout or write error means the socket is half-open: the broker is
      // gone but the OS never delivered a close event. Destroy the socket so
      // the onClose handler emits "disconnected" and the extension reconnects.
      const socket = this.socket;
      if (socket && !socket.destroyed) {
        this.disconnectError = toError(error);
        socket.destroy();
      }
    } finally {
      this.livenessInFlight = false;
    }
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }

    return socket;
  }

  connect(session: SessionRegistration, sessionId?: string): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }

    return new Promise((resolve, reject) => {
      let socket: net.Socket;
      let target: BrokerConnectTarget;
      try {
        target = getBrokerConnectTarget();
        socket = connectToBrokerTarget(target);
      } catch (error) {
        reject(toError(error));
        return;
      }
      this.socket = socket;
      this.registration = session;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        this.startLivenessHeartbeat();
        resolve();
      };
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        this.stopLivenessHeartbeat();
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this._features.clear();
        this.registration = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
          // A socket error after registration means the connection is dead.
          // Destroy the socket so onClose fires and emits "disconnected",
          // driving the extension's reconnect path. Without this, a half-open
          // socket can linger with isConnected() returning true.
          if (!socket.destroyed) {
            socket.destroy();
          }
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      
      try {
        writeMessage(socket, {
          type: "register",
          session,
          ...(sessionId ? { sessionId } : {}),
          ...(typeof target === "string" ? {} : { stateId: target.stateId }),
        });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid registered message");
        }

        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }

        if (
          brokerMessage.features !== undefined
          && (!Array.isArray(brokerMessage.features) || !brokerMessage.features.every((feature) => typeof feature === "string"))
        ) {
          throw new Error("Invalid registered features");
        }

        this._sessionId = brokerMessage.sessionId;
        this._features = new Set((brokerMessage.features as string[] | undefined) ?? []);
        const registered: BrokerMessage = {
          type: "registered",
          sessionId: brokerMessage.sessionId,
          ...(this._features.size > 0 ? { features: [...this._features] } : {}),
        };
        this.emit("broker_message", registered);
        this.emit("_registered", registered);
        break;
      }

      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }

        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          // Late list responses can still arrive after the caller has already timed out.
          return;
        }

        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }

      case "channel_opened": {
        const { requestId, channel, selfMemberId, targetMemberId } = brokerMessage;
        if (
          typeof requestId !== "string"
          || !isChannelInfo(channel)
          || typeof selfMemberId !== "string"
          || typeof targetMemberId !== "string"
        ) {
          throw new Error("Invalid channel_opened message");
        }
        const pending = this.pendingChannelOpens.get(requestId);
        if (!pending) return;
        this.pendingChannelOpens.delete(requestId);
        const self = channel.members.find((member) => member.memberId === selfMemberId);
        const target = channel.members.find((member) => member.memberId === targetMemberId);
        if (!self || !target) {
          pending.reject(new Error("Invalid channel_opened membership"));
          return;
        }
        const binding: ChannelBinding = {
          channel,
          selfMemberId,
          targetMemberId,
          targetSessionId: target.sessionId,
        };
        this.channelBindings.set(target.sessionId, binding);
        pending.resolve(binding);
        break;
      }

      case "channel_closed": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.channelId !== "string") {
          throw new Error("Invalid channel_closed message");
        }
        for (const [targetId, binding] of this.channelBindings) {
          if (binding.channel.channelId === brokerMessage.channelId) this.channelBindings.delete(targetId);
        }
        const pending = this.pendingChannelCloses.get(brokerMessage.requestId);
        if (pending) {
          this.pendingChannelCloses.delete(brokerMessage.requestId);
          pending.resolve();
        }
        break;
      }

      case "channel_open_failed": {
        const { requestId, reason, code, retryable } = brokerMessage;
        if (typeof requestId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid channel_open_failed message");
        }
        const pending = this.pendingChannelOpens.get(requestId);
        if (pending) {
          this.pendingChannelOpens.delete(requestId);
          const error = new Error(reason) as Error & { code?: string; retryable?: boolean };
          if (typeof code === "string") error.code = code;
          if (typeof retryable === "boolean") error.retryable = retryable;
          pending.reject(error);
          break;
        }
        const closePending = this.pendingChannelCloses.get(requestId);
        if (!closePending) return;
        this.pendingChannelCloses.delete(requestId);
        const error = new Error(reason) as Error & { code?: string; retryable?: boolean };
        if (typeof code === "string") error.code = code;
        if (typeof retryable === "boolean") error.retryable = retryable;
        closePending.reject(error);
        break;
      }

      case "message": {
        const { from, message } = brokerMessage;
        if (!isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }
        if (!this.supportsFeature(CHANNEL_BUS_FEATURE) || !message.channel) {
          throw new Error("E_CHANNEL_REQUIRED: conversational messages require channel-v1");
        }

        this.emit("message", from, message);
        break;
      }

      case "delivered": {
        const { messageId } = brokerMessage;
        if (typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          delivered: true,
          state: brokerMessage.state === "queued" || brokerMessage.state === "socket_delivered" ? brokerMessage.state : "socket_delivered",
          ...(typeof brokerMessage.channelId === "string" ? { channelId: brokerMessage.channelId } : {}),
        });
        break;
      }

      case "delivery_failed": {
        const { messageId, reason } = brokerMessage;
        if (typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          delivered: false,
          state: "failed",
          reason,
          ...(typeof brokerMessage.code === "string" ? { code: brokerMessage.code } : {}),
          ...(typeof brokerMessage.retryable === "boolean" ? { retryable: brokerMessage.retryable } : {}),
          ...(typeof brokerMessage.outcomeKnown === "boolean" ? { outcomeKnown: brokerMessage.outcomeKnown } : {}),
          ...(typeof brokerMessage.channelId === "string" ? { channelId: brokerMessage.channelId } : {}),
        });
        break;
      }

      case "message_receipt": {
        if (!isSessionInfo(brokerMessage.from) || !isMessageReceipt(brokerMessage.receipt)) {
          throw new Error("Invalid message_receipt event");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("message_receipt", brokerMessage.from, brokerMessage.receipt);
        break;
      }

      case "message_control": {
        if (!isSessionInfo(brokerMessage.from) || !isMessageControl(brokerMessage.control)) {
          throw new Error("Invalid message_control event");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("message_control", brokerMessage.from, brokerMessage.control);
        break;
      }

      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }

        const message: BrokerMessage = { type: "session_joined", session: brokerMessage.session };
        this.emit("broker_message", message);
        this.emit("session_joined", brokerMessage.session);
        break;
      }

      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }

        const message: BrokerMessage = { type: "session_left", sessionId: brokerMessage.sessionId };
        this.emit("broker_message", message);
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }

      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }

        const message: BrokerMessage = { type: "presence_update", session: brokerMessage.session };
        this.emit("broker_message", message);
        this.emit("presence_update", brokerMessage.session);
        break;
      }

      case "error": {
        if (typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }

        if (this._sessionId === null) {
          throw new Error(brokerMessage.error);
        }
        this.emit("error", new Error(brokerMessage.error));
        break;
      }

      case "extension_owner": {
        const hasOwnerId = typeof brokerMessage.ownerId === "string";
        const hasOwnerEpoch = typeof brokerMessage.ownerEpoch === "string";
        if (
          typeof brokerMessage.namespace !== "string"
          || hasOwnerId !== hasOwnerEpoch
          || (brokerMessage.ownerId !== undefined && !hasOwnerId)
          || (brokerMessage.ownerEpoch !== undefined && !hasOwnerEpoch)
        ) {
          throw new Error("Invalid extension_owner message");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("extension_owner", brokerMessage);
        break;
      }

      case "extension_message": {
        const hasOwnerId = typeof brokerMessage.ownerId === "string";
        const hasOwnerEpoch = typeof brokerMessage.ownerEpoch === "string";
        if (
          typeof brokerMessage.namespace !== "string"
          || typeof brokerMessage.fromSessionId !== "string"
          || hasOwnerId !== hasOwnerEpoch
          || (brokerMessage.ownerId !== undefined && !hasOwnerId)
          || (brokerMessage.ownerEpoch !== undefined && !hasOwnerEpoch)
        ) {
          throw new Error("Invalid extension_message");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("extension_message", brokerMessage);
        break;
      }

      case "extension_state": {
        if (
          typeof brokerMessage.namespace !== "string"
          || !Number.isSafeInteger(brokerMessage.revision)
          || Number(brokerMessage.revision) < 0
        ) {
          throw new Error("Invalid extension_state");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("extension_state", brokerMessage);
        break;
      }

      case "extension_state_result": {
        if (
          typeof brokerMessage.namespace !== "string"
          || typeof brokerMessage.committed !== "boolean"
          || !Number.isSafeInteger(brokerMessage.revision)
          || Number(brokerMessage.revision) < 0
          || (brokerMessage.reason !== undefined && typeof brokerMessage.reason !== "string")
        ) {
          throw new Error("Invalid extension_state_result");
        }
        this.emit("broker_message", brokerMessage as BrokerMessage);
        this.emit("extension_state_result", brokerMessage);
        break;
      }

      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.disconnecting = true;
    this.disconnectError = null;
    this.stopLivenessHeartbeat();
    this.failPending(new Error("Client disconnected"));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }

  updateExtensionCapabilities(extensions: SessionRegistration["extensions"]): void {
    if (!this.supportsFeature(EXTENSION_BUS_FEATURE)) return;
    const socket = this.requireActiveSocket();
    writeMessage(socket, { type: "extension_capabilities_update", extensions: extensions ?? [] });
  }

  listSessions(options: { timeoutMs?: number } = {}): Promise<SessionInfo[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, options.timeoutMs ?? 5000);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  private async resolveExactTarget(target: string): Promise<{ id: string; sessions: SessionInfo[] }> {
    const sessions = await this.listSessions();
    const byId = sessions.find((session) => session.id === target);
    if (byId) return { id: byId.id, sessions };
    const lower = target.toLowerCase();
    const byName = sessions.filter((session) => session.name?.toLowerCase() === lower);
    if (byName.length === 1) return { id: byName[0]!.id, sessions };
    if (byName.length > 1) throw Object.assign(new Error(`Multiple sessions named "${target}"; use an exact session ID.`), { code: "E_TARGET_AMBIGUOUS" });
    const byPrefix = sessions.filter((session) => session.id.startsWith(target));
    if (byPrefix.length === 1) return { id: byPrefix[0]!.id, sessions };
    if (byPrefix.length > 1) throw Object.assign(new Error(`Multiple sessions match ID prefix "${target}"; use a longer ID.`), { code: "E_TARGET_AMBIGUOUS" });
    // An exact stable ID may refer to a disconnected channel member. The
    // broker will accept it only when it can prove the prior membership.
    return { id: target, sessions };
  }

  private enforceLocalChannelPolicy(targetSessionId: string, sessions: SessionInfo[], intended?: string): void {
    const registration = this.registration;
    if (!registration?.cwd) return;
    const channelFile = findChannelFile(registration.cwd);
    if (!channelFile) return;
    const config = loadChannel(channelFile);
    const selfSession = sessions.find((session) => session.id === this._sessionId) ?? { id: this._sessionId ?? "" };
    if (!channelMemberFor(config, selfSession)) {
      const error = new Error(`E_SENDER_NOT_MEMBER: current session is not a member of channel "${config.name}"`) as Error & { code?: string };
      error.code = "E_SENDER_NOT_MEMBER";
      throw error;
    }
    const targetSession = sessions.find((session) => session.id === targetSessionId) ?? { id: targetSessionId };
    // For a disconnected member only its exact configured ID is admissible;
    // a name-only entry cannot be proven against a missing endpoint.
    const rejection = channelRejectsSession(config, targetSession);
    if (rejection) {
      const error = new Error(`E_TARGET_NOT_MEMBER: ${rejection}`) as Error & { code?: string };
      error.code = "E_TARGET_NOT_MEMBER";
      throw error;
    }
    if (!intended) return;
    const boundId = resolveBoundId(config, intended);
    if (boundId && boundId !== targetSessionId) {
      const error = new Error(`E_BINDING_MISMATCH: intended identity "${intended}" is bound to ${boundId}, not ${targetSessionId}`) as Error & { code?: string };
      error.code = "E_BINDING_MISMATCH";
      throw error;
    }
    if (!boundId) {
      const intendedName = intended.trim().toLowerCase();
      const configuredMember = config.members.find((member) => member.name?.trim().toLowerCase() === intendedName);
      if (!configuredMember || !configuredMember.id || !config.allowNameOnly) {
        const error = new Error(`E_BINDING_REQUIRED: intended identity "${intended}" must have an exact configured session ID`) as Error & { code?: string };
        error.code = "E_BINDING_REQUIRED";
        throw error;
      }
      const targetMember = channelMemberFor(config, targetSession);
      if (!targetMember || targetMember.name?.trim().toLowerCase() !== intendedName) {
        const error = new Error(`E_BINDING_MISMATCH: intended identity "${intended}" does not match the channel target`) as Error & { code?: string };
        error.code = "E_BINDING_MISMATCH";
        throw error;
      }
    }
  }

  /**
   * Open or reuse a broker-owned channel. The target must already be resolved
   * to an exact session ID; names never cross this handshake boundary.
   */
  openChannel(targetSessionId: string, lifecycle: ChannelLifecycle = "ephemeral"): Promise<ChannelBinding> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (!this.supportsFeature(CHANNEL_BUS_FEATURE)) {
      const error = new Error("E_CHANNEL_REQUIRED: connected broker does not support channel-v1") as Error & { code?: string };
      error.code = "E_CHANNEL_REQUIRED";
      return Promise.reject(error);
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingChannelOpens.has(requestId)) return;
        this.pendingChannelOpens.delete(requestId);
        const error = new Error("Channel open timeout") as Error & { code?: string; retryable?: boolean };
        error.code = "E_CHANNEL_OPEN_TIMEOUT";
        error.retryable = true;
        reject(error);
      }, 10000);
      this.pendingChannelOpens.set(requestId, {
        resolve: (binding) => {
          clearTimeout(timeout);
          resolve(binding);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        writeMessage(socket, { type: "channel_open", requestId, targetSessionId, lifecycle });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingChannelOpens.delete(requestId);
        reject(toError(error));
      }
    });
  }

  closeChannel(binding: ChannelBinding): Promise<void> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingChannelCloses.has(requestId)) return;
        this.pendingChannelCloses.delete(requestId);
        reject(new Error("Channel close timeout"));
      }, 5000);
      this.pendingChannelCloses.set(requestId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        writeMessage(socket, {
          type: "channel_close",
          requestId,
          channelId: binding.channel.channelId,
          channelEpoch: binding.channel.epoch,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingChannelCloses.delete(requestId);
        reject(toError(error));
      }
    });
  }

  async send(to: string, options: SendOptions): Promise<SendResult> {
    const messageId = options.messageId ?? randomUUID();
    let targetSessionId: string;
    let binding: ChannelBinding;
    try {
      const target = await this.resolveExactTarget(to);
      targetSessionId = target.id;
      this.enforceLocalChannelPolicy(targetSessionId, target.sessions, options.intended);
      binding = await this.openChannel(targetSessionId);
    } catch (error) {
      const normalized = error as Error & { code?: string; retryable?: boolean };
      if (normalized.code?.startsWith("E_")) {
        return {
          id: messageId,
          delivered: false,
          state: "failed",
          reason: normalized.message,
          code: normalized.code,
          retryable: normalized.retryable,
          outcomeKnown: true,
        };
      }
      throw error;
    }
    const socket = this.requireActiveSocket();
    const self = binding.channel.members.find((member) => member.memberId === binding.selfMemberId);
    const target = binding.channel.members.find((member) => member.memberId === binding.targetMemberId);
    if (!self || !target) throw new Error("E_CHANNEL_NOT_FOUND: channel membership is incomplete");
    const address: ChannelAddress = {
      channelId: binding.channel.channelId,
      channelEpoch: binding.channel.epoch,
      fromMemberId: self.memberId,
      toMemberId: target.memberId,
      targetBindingEpoch: target.bindingEpoch,
    };
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      senderSequence: this.nextSenderSequence++,
      supersedes: options.supersedes,
      retryOf: options.retryOf,
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      channel: address,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    return new Promise((resolve, reject) => {
      if (this.pendingSends.has(messageId)) {
        reject(new Error(`Message ${messageId} is already being sent`));
        return;
      }
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          const error = new Error(`E_DELIVERY_TIMEOUT_UNKNOWN: send outcome for ${messageId} is unknown`) as Error & {
            code?: string;
            retryable?: boolean;
            outcomeKnown?: boolean;
            messageId?: string;
          };
          error.code = "E_DELIVERY_TIMEOUT_UNKNOWN";
          error.retryable = false;
          error.outcomeKnown = false;
          error.messageId = messageId;
          wrappedReject(error);
        }
      }, 10000);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "channel_send", channel: address, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  cancelMessage(messageId: string): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return new Promise((resolve, reject) => {
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Cancel timeout"));
        }
      }, 10000);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, { type: "cancel_message", messageId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  sendMessageReceipt(receipt: MessageReceipt): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    writeMessage(socket, { type: "message_receipt", receipt });
  }

  cancelAsk(messageId: string): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    try {
      writeMessage(socket, { type: "cancel_ask", messageId });
    } catch {
      // Cancellation is best-effort; local waiter cleanup must still proceed.
    }
  }

  updatePresence(updates: { name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }

  sendExtensionMessage(message: Extract<ClientMessage, { type: "extension_publish" | "extension_state_commit" }>): void {
    if (!this.supportsFeature(EXTENSION_BUS_FEATURE)) {
      throw new Error(`Connected broker does not support ${EXTENSION_BUS_FEATURE}`);
    }
    const socket = this.requireActiveSocket();
    writeMessage(socket, message);
  }

  onBrokerMessage(handler: (message: BrokerMessage) => void): () => void {
    this.on("broker_message", handler);
    return () => this.off("broker_message", handler);
  }

  onMessageReceipt(handler: (from: SessionInfo, receipt: MessageReceipt) => void): () => void {
    this.on("message_receipt", handler);
    return () => this.off("message_receipt", handler);
  }

  onMessageControl(handler: (from: SessionInfo, control: MessageControl) => void): () => void {
    this.on("message_control", handler);
    return () => this.off("message_control", handler);
  }
}
