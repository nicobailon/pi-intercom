import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerConnectTarget, type BrokerConnectTarget } from "./paths.ts";
import { isMessage, isMessageControl, isMessageReceipt, isSessionInfo } from "./protocol.ts";
import { EXTENSION_BUS_FEATURE } from "../types.ts";
import type {
  Attachment,
  BrokerMessage,
  ClientMessage,
  Message,
  MessageControl,
  MessageReceipt,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
  supersedes?: string;
  retryOf?: string;
}

interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
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

      case "message": {
        const { from, message } = brokerMessage;
        if (!isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
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
        pending.resolve({ id: messageId, delivered: true });
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
        pending.resolve({ id: messageId, delivered: false, reason });
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

  send(to: string, options: SendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    
    const messageId = options.messageId ?? randomUUID();
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      senderSequence: this.nextSenderSequence++,
      supersedes: options.supersedes,
      retryOf: options.retryOf,
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

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
          wrappedReject(new Error("Send timeout"));
        }
      }, 10000);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, { type: "send", to, message });
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
