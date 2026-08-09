import net from "net";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getBrokerListenTarget,
  getBrokerPortFilePath,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";
import { getAskTimeoutMs } from "../config.ts";
import { sameCwd } from "../cwd.ts";
import { EXTENSION_BUS_FEATURE } from "../types.ts";
import type { SessionInfo, Message, Attachment, BrokerMessage, SessionRegistration, ExtensionCapability, MessageControl, MessageReceipt, MessageReceiptStatus } from "../types.ts";
import { ExtensionStateManager } from "./extension-state.ts";
import { assertNoLiveBroker } from "./runtime-claim.ts";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const BROKER_STATE_ID = randomUUID();
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1000;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const PRESENCE_HEARTBEAT_MS = 1000;
const MAX_EXTENSIONS_PER_SESSION = 32;
const MAX_EXTENSION_MESSAGE_BYTES = 16 * 1024;
const MAX_EXTENSION_STATE_BYTES = 64 * 1024;
const MESSAGE_RECEIPT_ROUTE_RETENTION_MS = 60 * 60 * 1000;
const DISCONNECTED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAILBOX_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MAILBOX_MESSAGES = 256;

function serializedPayloadSize(payload: unknown): number | null {
  try {
    const json = JSON.stringify(payload);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
  lastPresenceBroadcastAt: number;
  ownerOrder: number;
  extensions?: ExtensionCapability[];
}

interface NamespaceOwner {
  sessionId: string;
  socket: net.Socket;
  epoch: string;
}

interface ConnectionState {
  socket: net.Socket;
  tokens: number;
  lastRefillAt: number;
}

interface AskEdge {
  from: string;
  to: string;
  createdAt: number;
}

interface MessageReceiptRoute {
  from: string;
  to: string;
  createdAt: number;
}

interface DisconnectedSession {
  info: SessionInfo;
  disconnectedAt: number;
}

interface MailboxMessage {
  from: SessionInfo;
  target: SessionInfo;
  message: Message;
  queuedAt: number;
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

function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.messageId !== "string" || !isMessageReceiptStatus(receipt.status) || typeof receipt.timestamp !== "number") {
    return false;
  }
  return receipt.detail === undefined || typeof receipt.detail === "string";
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
    if (message[key] !== undefined && typeof message[key] !== "number") {
      return false;
    }
  }

  if (message.supersedes !== undefined && typeof message.supersedes !== "string") {
    return false;
  }

  if (message.retryOf !== undefined && typeof message.retryOf !== "string") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }
  if (session.runtimeFallbackAlias !== undefined && typeof session.runtimeFallbackAlias !== "boolean") {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private askEdges = new Map<string, AskEdge>();
  private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
  private disconnectedSessions = new Map<string, DisconnectedSession>();
  private mailboxMessages: MailboxMessage[] = [];
  private connections = new Set<net.Socket>();
  private unregisteredConnections = new Set<net.Socket>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly askTimeoutMs = getAskTimeoutMs();
  private namespaceOwners = new Map<string, NamespaceOwner>();
  private nextOwnerOrder = 1;
  private extensionStateManager: ExtensionStateManager;

  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    assertNoLiveBroker(PID_PATH);
    this.extensionStateManager = new ExtensionStateManager(INTERCOM_DIR);
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    const onListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint: BrokerConnectTarget = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID,
        };
        writeFileSync(PORT_PATH, `${JSON.stringify(endpoint)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid})`);
    };

    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onListening);
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    let sessionId: string | null = null;
    let registrationTimeout: NodeJS.Timeout | null = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionId) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const connection: ConnectionState = {
      socket,
      tokens: RATE_LIMIT_CAPACITY,
      lastRefillAt: Date.now(),
    };

    const reader = createMessageReader((msg) => {
      if (!this.consumeToken(connection)) {
        writeMessage(socket, { type: "error", error: "Intercom broker rate limit exceeded" });
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
        if (id) {
          clearRegistrationTimeout();
        } else {
          armRegistrationTimeout();
        }
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      clearRegistrationTimeout();
      this.connections.delete(socket);
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing.info);
          this.sessions.delete(sessionId);
          this.clearMessageReceiptRoutesForSession(sessionId);
          this.broadcast({ type: "session_left", sessionId }, sessionId);
          this.recomputeNamespaceOwners();
          this.scheduleShutdownCheck();
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private evictOldestUnregisteredConnections(currentSocket: net.Socket): void {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }

  private consumeToken(connection: ConnectionState, now = Date.now()): boolean {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * RATE_LIMIT_REFILL_PER_SECOND / 1000,
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < 1) {
      return false;
    }
    connection.tokens -= 1;
    return true;
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;

    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
      });
      return;
    }

    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        
        let id: string = randomUUID();
        if (clientMessage.sessionId !== undefined) {
          if (!isSessionId(clientMessage.sessionId)) {
            throw new Error("Invalid register sessionId");
          }
          id = clientMessage.sessionId;
        }
        const session = clientMessage.session;
        const extensions = session.extensions;
        if (extensions !== undefined) {
          if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
            throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
          }
          for (const extension of extensions) {
            if (!this.validateExtensionCapability(extension)) {
              throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
            }
          }
        }

        this.pruneDisconnectedSessions();
        this.pruneMailboxMessages();
        const previous = this.sessions.get(id);
        if (!previous && this.sessions.size >= MAX_SESSIONS) {
          writeMessage(socket, { type: "error", error: "Too many registered intercom sessions" });
          socket.destroy();
          break;
        }
        if (previous) {
          this.clearAskEdgesForSession(id);
          this.clearMessageReceiptRoutesForSession(id);
          previous.socket.end();
        }
        setId(id);
        const info: SessionInfo = {
          id,
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(session.runtimeFallbackAlias !== undefined ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {}),
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
        };

        const connectedSession: ConnectedSession = {
          socket,
          info,
          lastPresenceBroadcastAt: Date.now(),
          ownerOrder: previous?.ownerOrder ?? this.nextOwnerOrder++,
          extensions,
        };
        this.sessions.set(id, connectedSession);
        this.disconnectedSessions.delete(id);
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        // This must be the first broker message. Older clients ignore the
        // additive features field; newer clients use it to avoid sending
        // extension operations to an older broker.
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          features: [EXTENSION_BUS_FEATURE],
        });
        this.broadcast({ type: "session_joined", session: info }, id);

        this.recomputeNamespaceOwners();
        this.flushMailboxForSession(connectedSession);

        if (extensions) {
          for (const ext of extensions) {
            const owner = this.namespaceOwners.get(ext.namespace);
            writeMessage(socket, {
              type: "extension_owner",
              namespace: ext.namespace,
              ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
            });
            const state = this.extensionStateManager.loadState(ext.namespace);
            if (state) {
              writeMessage(socket, {
                type: "extension_state",
                namespace: ext.namespace,
                revision: state.revision,
                payload: state.payload,
              });
            }
          }
        }
        break;
      }

      case "unregister": {
        if (!currentId) {
          throw new Error("Received unregister before register");
        }
        const existing = this.sessions.get(currentId);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing.info);
          this.sessions.delete(currentId);
          this.clearMessageReceiptRoutesForSession(currentId);
          this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
          this.recomputeNamespaceOwners();
          this.scheduleShutdownCheck();
        }
        setId(null);
        break;
      }

      case "extension_capabilities_update": {
        if (!currentId) {
          throw new Error("Received extension_capabilities_update before register");
        }
        const session = this.sessions.get(currentId);
        if (!session || session.socket !== socket) {
          throw new Error("Extension capability session not found");
        }
        const extensions = clientMessage.extensions;
        if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
          throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
        }
        for (const extension of extensions) {
          if (!this.validateExtensionCapability(extension)) {
            throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
          }
        }
        session.extensions = extensions;
        this.recomputeNamespaceOwners();
        for (const extension of extensions) {
          const owner = this.namespaceOwners.get(extension.namespace);
          writeMessage(socket, {
            type: "extension_owner",
            namespace: extension.namespace,
            ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          });
          const state = this.extensionStateManager.loadState(extension.namespace);
          if (state) {
            writeMessage(socket, {
              type: "extension_state",
              namespace: extension.namespace,
              revision: state.revision,
              payload: state.payload,
            });
          }
        }
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        if (!currentId) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId,
            reason: "Invalid message format",
          });
          break;
        }

        const brokerReceivedAt = Date.now();
        this.pruneAskEdges();
        this.pruneMessageReceiptRoutes(brokerReceivedAt);
        const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;

        const targets = this.findSessions(clientMessage.to);
        if (targets.length === 1) {
          if (message.replyTo && !replyEdge) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Reply target does not match a pending ask",
            });
            break;
          }
          const fromSession = this.sessions.get(currentId);
          if (!fromSession || fromSession.socket !== socket) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }
          const target = targets[0];
          if (message.supersedes) {
            const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
            if (!supersededRoute || supersededRoute.from !== currentId || supersededRoute.to !== target.info.id) {
              writeMessage(socket, {
                type: "delivery_failed",
                messageId: message.id,
                reason: "Supersede target does not match a previous message from this sender to this receiver",
              });
              break;
            }
          }
          if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.info.id)) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Reply target does not match the pending ask",
            });
            break;
          }
          if (message.expectsReply) {
            const reverseEdge = Array.from(this.askEdges.entries()).find(([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === target.info.id && edge.to === currentId);
            if (reverseEdge) {
              writeMessage(socket, {
                type: "delivery_failed",
                messageId: message.id,
                reason: "Mutual ask refused: target session is already waiting for a reply from this session.",
              });
              break;
            }
            this.askEdges.set(message.id, { from: currentId, to: target.info.id, createdAt: Date.now() });
          }
          const deliveredMessage: Message = {
            ...message,
            brokerReceivedAt,
            brokerDeliveredAt: Date.now(),
          };
          if (message.supersedes) {
            const control: MessageControl = {
              action: "supersede",
              messageId: message.supersedes,
              supersededBy: message.id,
              timestamp: Date.now(),
            };
            writeMessage(target.socket, {
              type: "message_control",
              from: fromSession.info,
              control,
            });
          }
          writeMessage(target.socket, {
            type: "message",
            from: fromSession.info,
            message: deliveredMessage,
          });
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
          }
          this.messageReceiptRoutes.set(message.id, { from: currentId, to: target.info.id, createdAt: brokerReceivedAt });
          writeMessage(socket, { type: "delivered", messageId: message.id });
          break;
        }

        if (targets.length > 1) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`,
          });
          break;
        }

        const disconnectedTargets = this.findDisconnectedSessions(clientMessage.to);
        if (disconnectedTargets.length === 1) {
          if (message.replyTo && !replyEdge) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Reply target does not match a pending ask",
            });
            break;
          }
          const fromSession = this.sessions.get(currentId);
          if (!fromSession || fromSession.socket !== socket) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }
          const target = disconnectedTargets[0]!.info;
          if (message.supersedes) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Supersede target is not connected",
            });
            break;
          }
          if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.id)) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Reply target does not match the pending ask",
            });
            break;
          }
          if (message.expectsReply) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Target session is not currently connected; blocking asks are not queued",
            });
            break;
          }
          const liveMailboxTarget = this.findUniqueLiveSessionForDisconnectedSession(target, currentId);
          if (liveMailboxTarget) {
            const deliveredMessage: Message = {
              ...message,
              brokerReceivedAt,
              brokerDeliveredAt: Date.now(),
            };
            writeMessage(liveMailboxTarget.socket, {
              type: "message",
              from: fromSession.info,
              message: deliveredMessage,
            });
            this.messageReceiptRoutes.set(message.id, { from: currentId, to: liveMailboxTarget.info.id, createdAt: brokerReceivedAt });
          } else {
            this.queueMailboxMessage(fromSession.info, target, message, brokerReceivedAt);
          }
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
          }
          writeMessage(socket, { type: "delivered", messageId: message.id });
          break;
        }

        if (disconnectedTargets.length > 1) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: `Multiple disconnected sessions named \"${clientMessage.to}\" can receive queued mail. Use the session ID instead.`,
          });
          break;
        }

        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Session not found",
        });
        break;
      }

      case "message_receipt": {
        if (!currentId) {
          throw new Error("Received message_receipt before register");
        }
        if (!isMessageReceipt(clientMessage.receipt)) {
          throw new Error("Invalid message_receipt message");
        }
        this.pruneMessageReceiptRoutes();
        const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId);
        const receiver = this.sessions.get(currentId);
        const sender = route ? this.sessions.get(route.from) : undefined;
        if (route?.to === currentId && receiver?.socket === socket && sender) {
          writeMessage(sender.socket, {
            type: "message_receipt",
            from: receiver.info,
            receipt: clientMessage.receipt,
          });
        }
        break;
      }

      case "cancel_message": {
        if (!currentId) {
          throw new Error("Received cancel_message before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_message message");
        }
        this.pruneMessageReceiptRoutes();
        this.pruneMailboxMessages();
        const sender = this.sessions.get(currentId);
        const queuedIndex = this.mailboxMessages.findIndex(entry => entry.message.id === clientMessage.messageId && entry.from.id === currentId);
        if (queuedIndex >= 0 && sender?.socket === socket) {
          this.mailboxMessages.splice(queuedIndex, 1);
          const edge = this.askEdges.get(clientMessage.messageId);
          if (edge?.from === currentId) {
            this.askEdges.delete(clientMessage.messageId);
          }
          writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
          break;
        }
        const route = this.messageReceiptRoutes.get(clientMessage.messageId);
        const receiver = route ? this.sessions.get(route.to) : undefined;
        if (route?.from !== currentId || sender?.socket !== socket || !receiver) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: clientMessage.messageId,
            reason: "Message cannot be cancelled by this session",
          });
          break;
        }
        writeMessage(receiver.socket, {
          type: "message_control",
          from: sender.info,
          control: {
            action: "cancel",
            messageId: clientMessage.messageId,
            timestamp: Date.now(),
          },
        });
        const edge = this.askEdges.get(clientMessage.messageId);
        if (edge?.from === currentId) {
          this.askEdges.delete(clientMessage.messageId);
        }
        writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
        break;
      }

      case "cancel_ask": {
        if (!currentId) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentId);
        const edge = this.askEdges.get(clientMessage.messageId);
        if (session?.socket === socket && edge?.from === currentId) {
          this.askEdges.delete(clientMessage.messageId);
        }
        break;
      }

      case "presence": {
        if (!currentId) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            if (session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.runtimeFallbackAlias !== undefined) {
            if (typeof clientMessage.runtimeFallbackAlias !== "boolean") {
              throw new Error("Invalid presence runtimeFallbackAlias");
            }
            if (session.info.runtimeFallbackAlias !== clientMessage.runtimeFallbackAlias) {
              session.info.runtimeFallbackAlias = clientMessage.runtimeFallbackAlias;
              changed = true;
            }
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          // Context-usage fields: a number updates, an explicit null CLEARS (the
          // value is unknown right after a compaction — delete rather than carry
          // the stale-high value forward), undefined leaves the field untouched.
          if (clientMessage.contextPct !== undefined) {
            if (clientMessage.contextPct === null) {
              if (session.info.contextPct !== undefined) { delete session.info.contextPct; changed = true; }
            } else if (typeof clientMessage.contextPct !== "number") {
              throw new Error("Invalid presence contextPct");
            } else if (session.info.contextPct !== clientMessage.contextPct) {
              session.info.contextPct = clientMessage.contextPct;
              changed = true;
            }
          }
          if (clientMessage.contextTokens !== undefined) {
            if (clientMessage.contextTokens === null) {
              if (session.info.contextTokens !== undefined) { delete session.info.contextTokens; changed = true; }
            } else if (typeof clientMessage.contextTokens !== "number") {
              throw new Error("Invalid presence contextTokens");
            } else if (session.info.contextTokens !== clientMessage.contextTokens) {
              session.info.contextTokens = clientMessage.contextTokens;
              changed = true;
            }
          }
          if (clientMessage.contextWindow !== undefined) {
            if (clientMessage.contextWindow === null) {
              if (session.info.contextWindow !== undefined) { delete session.info.contextWindow; changed = true; }
            } else if (typeof clientMessage.contextWindow !== "number") {
              throw new Error("Invalid presence contextWindow");
            } else if (session.info.contextWindow !== clientMessage.contextWindow) {
              session.info.contextWindow = clientMessage.contextWindow;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcast({ type: "presence_update", session: session.info }, currentId);
          }
        }
        break;
      }

      case "extension_publish": {
        this.handleExtensionPublish(socket, currentId, clientMessage);
        break;
      }

      case "extension_state_commit": {
        this.handleExtensionStateCommit(socket, currentId, clientMessage);
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private rememberDisconnectedSession(info: SessionInfo, now = Date.now()): void {
    this.disconnectedSessions.set(info.id, { info: { ...info }, disconnectedAt: now });
    this.pruneDisconnectedSessions(now);
  }

  private pruneDisconnectedSessions(now = Date.now()): void {
    for (const [sessionId, session] of this.disconnectedSessions) {
      if (now - session.disconnectedAt > DISCONNECTED_SESSION_RETENTION_MS) {
        this.disconnectedSessions.delete(sessionId);
      }
    }
  }

  private pruneMailboxMessages(now = Date.now()): void {
    for (let index = this.mailboxMessages.length - 1; index >= 0; index -= 1) {
      const entry = this.mailboxMessages[index]!;
      if (now - entry.queuedAt > MAILBOX_MESSAGE_RETENTION_MS) {
        if (entry.message.expectsReply) {
          this.askEdges.delete(entry.message.id);
        }
        this.messageReceiptRoutes.delete(entry.message.id);
        this.mailboxMessages.splice(index, 1);
      }
    }
  }

  private queueMailboxMessage(from: SessionInfo, target: SessionInfo, message: Message, brokerReceivedAt: number): void {
    this.pruneMailboxMessages(brokerReceivedAt);
    while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      const evicted = this.mailboxMessages.shift();
      if (!evicted) break;
      if (evicted.message.expectsReply) {
        this.askEdges.delete(evicted.message.id);
      }
      this.messageReceiptRoutes.delete(evicted.message.id);
    }
    this.mailboxMessages.push({
      from: { ...from },
      target: { ...target },
      message: { ...message, brokerReceivedAt },
      queuedAt: brokerReceivedAt,
    });
  }

  private flushMailboxForSession(session: ConnectedSession, now = Date.now()): void {
    this.pruneMailboxMessages(now);
    const sessionName = session.info.name?.toLowerCase();
    const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session.info).length === 1;

    for (let index = 0; index < this.mailboxMessages.length;) {
      const entry = this.mailboxMessages[index]!;
      const matchesId = entry.target.id === session.info.id;
      const matchesSenderIdentity = Boolean(
        sessionName
        && entry.from.name?.toLowerCase() === sessionName
        && sameCwd(entry.from.cwd, session.info.cwd),
      );
      const matchesUniqueName = Boolean(
        uniqueMailboxIdentity
        && sessionName
        && !matchesSenderIdentity
        && entry.target.name?.toLowerCase() === sessionName
        && sameCwd(entry.target.cwd, session.info.cwd),
      );
      if (!matchesId && !matchesUniqueName) {
        index += 1;
        continue;
      }

      this.mailboxMessages.splice(index, 1);
      const edge = this.askEdges.get(entry.message.id);
      if (edge?.to === entry.target.id) {
        edge.to = session.info.id;
      }
      const deliveredMessage: Message = {
        ...entry.message,
        brokerDeliveredAt: Date.now(),
      };
      writeMessage(session.socket, {
        type: "message",
        from: entry.from,
        message: deliveredMessage,
      });
      this.messageReceiptRoutes.set(entry.message.id, {
        from: entry.from.id,
        to: session.info.id,
        createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
      });
    }
  }

  private pruneAskEdges(now = Date.now()): void {
    for (const [messageId, edge] of this.askEdges) {
      if (now - edge.createdAt > this.askTimeoutMs) {
        this.askEdges.delete(messageId);
      }
    }
  }

  private clearAskEdgesForSession(sessionId: string): void {
    for (const [messageId, edge] of this.askEdges) {
      if (edge.from === sessionId || edge.to === sessionId) {
        this.askEdges.delete(messageId);
      }
    }
  }

  private pruneMessageReceiptRoutes(now = Date.now()): void {
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (now - route.createdAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS) {
        this.messageReceiptRoutes.delete(messageId);
      }
    }
  }

  private clearMessageReceiptRoutesForSession(sessionId: string): void {
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (route.from === sessionId || route.to === sessionId) {
        this.messageReceiptRoutes.delete(messageId);
      }
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.sessions.entries())
      .filter(([id]) => id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findDisconnectedSessions(nameOrId: string): DisconnectedSession[] {
    this.pruneDisconnectedSessions();
    const byId = this.disconnectedSessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.disconnectedSessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.disconnectedSessions.entries())
      .filter(([id]) => id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findUniqueLiveSessionForDisconnectedSession(info: SessionInfo, senderId?: string): ConnectedSession | null {
    const matches = this.findLiveSessionsSharingMailboxIdentity(info)
      .filter((session) => session.info.id !== senderId);
    return matches.length === 1 ? matches[0]! : null;
  }

  /**
   * Mailbox identity is an explicit name plus directory, never name alone. A
   * runtime fallback alias is derived from the session id rather than chosen as
   * a durable identity, so it must not transfer mail to another process. This
   * also prevents two unnamed UUIDv7 sessions started close together from
   * inheriting each other's mailbox through a shared short alias.
   *
   * Directories compare through sameCwd so a relaunch that reports the same
   * directory differently (trailing slash, "."/"..", or a symlink such as macOS
   * /tmp vs /private/tmp) still matches.
   */
  private findLiveSessionsSharingMailboxIdentity(info: SessionInfo): ConnectedSession[] {
    const lowerName = info.name?.toLowerCase();
    if (!lowerName || info.runtimeFallbackAlias) {
      return [];
    }
    return Array.from(this.sessions.values()).filter(session =>
      session.info.name?.toLowerCase() === lowerName && sameCwd(session.info.cwd, info.cwd)
    );
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private validateExtensionCapability(cap: unknown): cap is ExtensionCapability {
    if (typeof cap !== "object" || cap === null) {
      return false;
    }
    const c = cap as Record<string, unknown>;
    if (typeof c.namespace !== "string" || typeof c.ownerEligible !== "boolean") {
      return false;
    }
    return this.validateNamespace(c.namespace);
  }

  private validateNamespace(ns: string): boolean {
    // ^[a-z0-9][a-z0-9._/-]{0,63}$
    if (ns.length === 0 || ns.length > 64) {
      return false;
    }
    if (!/^[a-z0-9]/.test(ns)) {
      return false;
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(ns)) {
      return false;
    }
    return true;
  }

  private recomputeNamespaceOwners(): void {
    const namespaces = new Set(this.namespaceOwners.keys());
    for (const session of this.sessions.values()) {
      for (const extension of session.extensions ?? []) {
        namespaces.add(extension.namespace);
      }
    }

    // For each namespace, elect owner by (startedAt, sessionId).
    for (const namespace of namespaces) {
      const candidates: Array<{ sessionId: string; session: ConnectedSession }> = [];
      for (const [sessionId, session] of this.sessions) {
        if (session.extensions) {
          const hasNamespace = session.extensions.some(
            (ext) => ext.namespace === namespace && ext.ownerEligible
          );
          if (hasNamespace) {
            candidates.push({ sessionId, session });
          }
        }
      }

      if (candidates.length === 0) {
        if (this.namespaceOwners.delete(namespace)) {
          for (const session of this.sessions.values()) {
            const isCapable = session.extensions?.some((extension) => extension.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, { type: "extension_owner", namespace });
            }
          }
        }
        continue;
      }

      // Use broker-owned registration order so clients cannot seize authority
      // by backdating their advertised session start time. Stable-ID socket
      // replacements preserve the original order.
      candidates.sort((a, b) => {
        if (a.session.ownerOrder !== b.session.ownerOrder) {
          return a.session.ownerOrder - b.session.ownerOrder;
        }
        return a.sessionId.localeCompare(b.sessionId);
      });

      const winner = candidates[0];
      const existing = this.namespaceOwners.get(namespace);

      // Check if owner changed or socket changed
      const ownerChanged = !existing || existing.sessionId !== winner.sessionId;
      const socketChanged = existing && existing.socket !== winner.session.socket;

      if (ownerChanged || socketChanged) {
        // Generate new epoch
        const epoch = randomUUID();
        this.namespaceOwners.set(namespace, {
          sessionId: winner.sessionId,
          socket: winner.session.socket,
          epoch,
        });

        // Broadcast owner change to all capable sessions
        for (const session of this.sessions.values()) {
          if (session.extensions?.length) {
            const isCapable = session.extensions.some((ext) => ext.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, {
                type: "extension_owner",
                namespace,
                ownerId: winner.sessionId,
                ownerEpoch: epoch,
              });
            }
          }
        }
      }
    }
  }

  private handleExtensionPublish(
    socket: net.Socket,
    currentId: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentId) {
      throw new Error("Received extension_publish before register");
    }

    const session = this.sessions.get(currentId);
    if (!session || session.socket !== socket) {
      writeMessage(socket, { type: "error", error: "Session not found" });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, { type: "error", error: "Session has not advertised extension capability" });
      return;
    }

    const namespace = msg.namespace;
    const audience = msg.audience;
    const ownerOnly = msg.ownerOnly === true;
    const ownerEpoch = msg.ownerEpoch;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, { type: "error", error: "Invalid namespace" });
      return;
    }

    if (audience !== "owner" && audience !== "capable") {
      writeMessage(socket, { type: "error", error: "Invalid audience" });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_MESSAGE_BYTES) {
      writeMessage(socket, { type: "error", error: "Invalid extension payload or payload exceeds 16 KiB limit" });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, { type: "error", error: "Sender does not have capability for this namespace" });
      return;
    }

    const owner = this.namespaceOwners.get(namespace);
    if ((audience === "owner" || ownerOnly) && !owner) {
      writeMessage(socket, { type: "error", error: "No owner for this namespace" });
      return;
    }

    // For owner-only messages, validate exact socket and epoch
    if (ownerOnly && owner) {
      if (typeof ownerEpoch !== "string") {
        writeMessage(socket, { type: "error", error: "ownerEpoch required for owner-only messages" });
        return;
      }
      if (currentId !== owner.sessionId || socket !== owner.socket || ownerEpoch !== owner.epoch) {
        writeMessage(socket, { type: "error", error: "Owner validation failed" });
        return;
      }
    }

    // Route message to appropriate audience
    for (const [recipientId, recipientSession] of this.sessions) {
      if (!recipientSession.extensions?.length) {
        continue;
      }

      const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
      if (!isCapable) {
        continue;
      }

      const shouldReceive =
        audience === "capable" ||
        (audience === "owner" && owner !== undefined &&
          recipientId === owner.sessionId &&
          recipientSession.socket === owner.socket);

      if (shouldReceive) {
        writeMessage(recipientSession.socket, {
          type: "extension_message",
          namespace,
          fromSessionId: currentId,
          ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          payload,
        });
      }
    }
  }

  private handleExtensionStateCommit(
    socket: net.Socket,
    currentId: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentId) {
      throw new Error("Received extension_state_commit before register");
    }

    const session = this.sessions.get(currentId);
    if (!session || session.socket !== socket) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session not found",
      });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session has not advertised extension capability",
      });
      return;
    }

    const namespace = msg.namespace;
    const ownerEpoch = msg.ownerEpoch;
    const expectedRevision = msg.expectedRevision;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(namespace),
        committed: false,
        revision: 0,
        reason: "Invalid namespace",
      });
      return;
    }

    if (typeof ownerEpoch !== "string") {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "Invalid ownerEpoch",
      });
      return;
    }

    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "Invalid expectedRevision",
      });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_STATE_BYTES) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "Invalid extension state or payload exceeds 64 KiB limit",
      });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "Sender does not have capability for this namespace",
      });
      return;
    }

    const owner = this.namespaceOwners.get(namespace);
    if (!owner) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "No owner for this namespace",
      });
      return;
    }

    // Validate owner, socket, and epoch
    if (currentId !== owner.sessionId || socket !== owner.socket || ownerEpoch !== owner.epoch) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(namespace),
        reason: "Owner validation failed",
      });
      return;
    }

    const result = this.extensionStateManager.commitState(namespace, expectedRevision, payload);

    // Send result to committer
    writeMessage(socket, {
      type: "extension_state_result",
      namespace,
      committed: result.committed,
      revision: result.revision,
      reason: result.reason,
    });

    // If committed, broadcast new state to all capable sessions
    if (result.committed) {
      for (const recipientSession of this.sessions.values()) {
        if (!recipientSession.extensions?.length) {
          continue;
        }

        const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
        if (isCapable) {
          writeMessage(recipientSession.socket, {
            type: "extension_state",
            namespace,
            revision: result.revision,
            payload,
          });
        }
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.askEdges.clear();
    this.messageReceiptRoutes.clear();
    this.disconnectedSessions.clear();
    this.mailboxMessages.length = 0;
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PORT_PATH);
    } catch {
      // The TCP endpoint file only exists when opt-in TCP transport is active.
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
