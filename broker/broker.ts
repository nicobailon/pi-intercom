import net from "net";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { isMessage, isMessageReceipt, isSessionId, isSessionRegistration } from "./protocol.ts";
import {
  ensureIntercomRuntimeDir,
  getBrokerListenTarget,
  getBrokerPortFilePath,
  getIntercomDirPath,
  INTERCOM_DIR_MODE,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";
import { getAskTimeoutMs } from "../config.ts";
import { sameCwd } from "../cwd.ts";
import { EXACT_SEND_FEATURE, EXTENSION_BUS_FEATURE } from "../types.ts";
import type { DeliveryState, SessionInfo, Message, BrokerMessage, ExtensionCapability, MessageControl } from "../types.ts";
import { ExtensionStateManager } from "./extension-state.ts";
import { assertNoLiveBroker } from "./runtime-claim.ts";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const PENDING_ASKS_DIR = join(INTERCOM_DIR, "pending-asks");
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
const DELIVERY_RECORD_RETENTION_MS = 60 * 60 * 1000;
const MAX_DELIVERY_RECORDS = 4096;

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
  key: string;
  scopeId?: string;
  lastPresenceBroadcastAt: number;
  ownerOrder: number;
  extensions?: ExtensionCapability[];
}

interface DeliveryRecord {
  fingerprint: string;
  state: DeliveryState;
  reason?: string;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
  createdAt: number;
}

interface NamespaceOwner {
  namespace: string;
  sessionKey: string;
  sessionId: string;
  socket: net.Socket;
  epoch: string;
  scopeId?: string;
}

interface ConnectionState {
  socket: net.Socket;
  tokens: number;
  lastRefillAt: number;
}

interface AskEdge {
  from: string;
  to: string;
  scopeId?: string;
  createdAt: number;
}

interface PendingAskRecord {
  askId: string;
  messageId: string;
  asker: { sessionId: string; name: string | null };
  target: { sessionId: string; name: string | null };
  question: string;
  createdAt: number;
  expiresAt: number;
}

interface MessageReceiptRoute {
  from: string;
  to: string;
  createdAt: number;
}

interface DisconnectedSession {
  info: SessionInfo;
  key: string;
  scopeId?: string;
  disconnectedAt: number;
}

interface MailboxMessage {
  from: SessionInfo;
  fromKey: string;
  fromScopeId?: string;
  target: SessionInfo;
  targetKey: string;
  targetScopeId?: string;
  message: Message;
  queuedAt: number;
}

function normalizeScopeId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid register scopeId");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sameScope(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

function scopedSessionKey(scopeId: string | undefined, sessionId: string): string {
  return JSON.stringify([scopeId ?? null, sessionId]);
}

function scopedExtensionKey(scopeId: string | undefined, namespace: string): string {
  return JSON.stringify([scopeId ?? null, namespace]);
}

function scopedExtensionStateNamespace(scopeId: string | undefined, namespace: string): string {
  if (!scopeId) {
    return namespace;
  }
  return JSON.stringify(["scope", createHash("sha256").update(scopeId).digest("hex"), namespace]);
}

function scopedPendingAskRecordPath(scopeId: string | undefined, messageId: string): string {
  if (!scopeId) {
    return pendingAskRecordPath(messageId);
  }
  const scopeHash = createHash("sha256").update(scopeId).digest("hex");
  return join(PENDING_ASKS_DIR, `${scopeHash}-${encodeURIComponent(messageId)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPendingAskRecord(value: unknown): value is PendingAskRecord {
  if (!isRecord(value) || !isRecord(value.asker) || !isRecord(value.target)) {
    return false;
  }
  return typeof value.askId === "string"
    && typeof value.messageId === "string"
    && typeof value.asker.sessionId === "string"
    && (typeof value.asker.name === "string" || value.asker.name === null)
    && typeof value.target.sessionId === "string"
    && (typeof value.target.name === "string" || value.target.name === null)
    && typeof value.question === "string"
    && Number.isSafeInteger(value.createdAt)
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt >= value.createdAt;
}

function pendingAskRecordPath(messageId: string): string {
  return join(PENDING_ASKS_DIR, `${encodeURIComponent(messageId)}.json`);
}

function ensurePendingAskRecordDir(): void {
  mkdirSync(PENDING_ASKS_DIR, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (process.platform !== "win32") {
    chmodSync(PENDING_ASKS_DIR, INTERCOM_DIR_MODE);
  }
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private askEdges = new Map<string, AskEdge>();
  private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
  private disconnectedSessions = new Map<string, DisconnectedSession>();
  private mailboxMessages: MailboxMessage[] = [];
  private deliveryRecords = new Map<string, DeliveryRecord>();
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
    ensurePendingAskRecordDir();
    this.prunePendingAskRecords();
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
    let sessionKey: string | null = null;
    let registrationTimeout: NodeJS.Timeout | null = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionKey) {
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
      this.handleMessage(socket, msg, sessionKey, (id) => {
        sessionKey = id;
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
      if (sessionKey) {
        const existing = this.sessions.get(sessionKey);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing);
          this.sessions.delete(sessionKey);
          this.clearMessageReceiptRoutesForSession(sessionKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, sessionKey, existing.scopeId);
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
    currentKey: string | null,
    setKey: (key: string | null) => void,
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

    if (currentKey === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentKey) {
          throw new Error("Received duplicate register message");
        }
        
        let id: string = randomUUID();
        if (clientMessage.sessionId !== undefined) {
          if (!isSessionId(clientMessage.sessionId)) {
            throw new Error("Invalid register sessionId");
          }
          id = clientMessage.sessionId;
        }
        const scopeId = normalizeScopeId(clientMessage.scopeId);
        const key = scopedSessionKey(scopeId, id);
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
        const previous = this.sessions.get(key);
        if (!previous && this.sessions.size >= MAX_SESSIONS) {
          writeMessage(socket, { type: "error", error: "Too many registered intercom sessions" });
          socket.destroy();
          break;
        }
        if (previous) {
          this.clearMessageReceiptRoutesForSession(key);
          previous.socket.end();
        }
        setKey(key);
        const info: SessionInfo = {
          id,
          endpointEpoch: randomUUID(),
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(session.runtimeFallbackAlias !== undefined ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {}),
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          ...(session.tmuxPane !== undefined ? { tmuxPane: session.tmuxPane } : {}),
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
        };

        const connectedSession: ConnectedSession = {
          socket,
          info,
          key,
          ...(scopeId ? { scopeId } : {}),
          lastPresenceBroadcastAt: Date.now(),
          ownerOrder: previous?.ownerOrder ?? this.nextOwnerOrder++,
          extensions,
        };
        this.sessions.set(key, connectedSession);
        this.disconnectedSessions.delete(key);
        
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
          features: [EXTENSION_BUS_FEATURE, EXACT_SEND_FEATURE],
        });
        this.broadcast({ type: "session_joined", session: info }, key, scopeId);

        this.recomputeNamespaceOwners();
        this.flushMailboxForSession(connectedSession);

        if (extensions) {
          for (const ext of extensions) {
            const owner = this.namespaceOwners.get(scopedExtensionKey(scopeId, ext.namespace));
            writeMessage(socket, {
              type: "extension_owner",
              namespace: ext.namespace,
              ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
            });
            const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(scopeId, ext.namespace));
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
        if (!currentKey) {
          throw new Error("Received unregister before register");
        }
        const existing = this.sessions.get(currentKey);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing);
          this.sessions.delete(currentKey);
          this.clearMessageReceiptRoutesForSession(currentKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, currentKey, existing.scopeId);
          this.recomputeNamespaceOwners();
          this.scheduleShutdownCheck();
        }
        setKey(null);
        break;
      }

      case "extension_capabilities_update": {
        if (!currentKey) {
          throw new Error("Received extension_capabilities_update before register");
        }
        const session = this.sessions.get(currentKey);
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
          const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, extension.namespace));
          writeMessage(socket, {
            type: "extension_owner",
            namespace: extension.namespace,
            ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          });
          const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(session.scopeId, extension.namespace));
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

        const requester = currentKey ? this.sessions.get(currentKey) : undefined;
        if (!requester || requester.socket !== socket) {
          throw new Error("List session not found");
        }
        const sessions = Array.from(this.sessions.values())
          .filter(session => sameScope(session.scopeId, requester.scopeId))
          .map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        if (!currentKey) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          this.writeDeliveryFailure(socket, messageId, "Invalid message format", "E_INVALID_MESSAGE");
          break;
        }
        const fromSession = this.sessions.get(currentKey);
        if (!fromSession || fromSession.socket !== socket) {
          this.writeDeliveryFailure(socket, message.id, "Sender session not found", "E_SENDER_NOT_FOUND");
          break;
        }

        const brokerReceivedAt = Date.now();
        this.pruneAskEdges();
        this.pruneMessageReceiptRoutes(brokerReceivedAt);
        const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;

        const hasTargetId = clientMessage.targetId !== undefined;
        const hasTargetEpoch = clientMessage.targetEpoch !== undefined;
        if (
          hasTargetId !== hasTargetEpoch
          || (hasTargetId && (typeof clientMessage.targetId !== "string" || clientMessage.targetId.length === 0))
          || (hasTargetEpoch && (typeof clientMessage.targetEpoch !== "string" || clientMessage.targetEpoch.length === 0))
        ) {
          this.writeDeliveryFailure(socket, message.id, "Exact target requires an id and endpoint epoch", "E_INVALID_TARGET");
          break;
        }
        if (hasTargetId && hasTargetEpoch) {
          const targetId = clientMessage.targetId as string;
          const targetEpoch = clientMessage.targetEpoch as string;
          const fingerprint = this.deliveryFingerprint(message, targetId);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          const exactTarget = this.sessions.get(scopedSessionKey(fromSession.scopeId, targetId));
          if (!exactTarget) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Session not found", "E_TARGET_NOT_FOUND");
            this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
            break;
          }
          if (exactTarget.info.endpointEpoch !== targetEpoch) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            this.writeDeliveryFailure(socket, message.id, "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            break;
          }
          clientMessage.to = targetId;
        }

        const targets = this.findSessions(clientMessage.to, fromSession.scopeId);
        if (targets.length === 1) {
          if (message.replyTo && !replyEdge) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
            break;
          }
          const target = targets[0];
          const fingerprint = this.deliveryFingerprint(message, target.info.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
            if (!supersededRoute || supersededRoute.from !== currentKey || supersededRoute.to !== target.key) {
              this.writeDeliveryFailure(socket, message.id, "Supersede target does not match a previous message from this sender to this receiver", "E_SUPERSEDE_TARGET");
              break;
            }
          }
          if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== target.key)) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
            break;
          }
          if (message.expectsReply) {
            const reverseEdge = Array.from(this.askEdges.entries()).find(([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === target.key && edge.to === currentKey);
            if (reverseEdge) {
              this.writeDeliveryFailure(socket, message.id, "Mutual ask refused: target session is already waiting for a reply from this session.", "E_MUTUAL_ASK");
              break;
            }
            this.writePendingAskRecord(message, fromSession, target.info, brokerReceivedAt);
            this.askEdges.set(message.id, {
              from: currentKey,
              to: target.key,
              ...(fromSession.scopeId ? { scopeId: fromSession.scopeId } : {}),
              createdAt: brokerReceivedAt,
            });
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
            this.updateDeliveryRecord(currentKey, message.supersedes, "failed", `Superseded by ${message.id}`, "E_DELIVERY_SUPERSEDED");
          }
          writeMessage(target.socket, {
            type: "message",
            from: fromSession.info,
            message: deliveredMessage,
          });
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
            this.removePendingAskRecord(message.replyTo, fromSession.scopeId);
          }
          this.messageReceiptRoutes.set(message.id, { from: currentKey, to: target.key, createdAt: brokerReceivedAt });
          this.recordDelivery(currentKey, message.id, fingerprint, "socket_delivered");
          this.writeDeliverySuccess(socket, message.id, "socket_delivered");
          break;
        }

        if (targets.length > 1) {
          this.writeDeliveryFailure(socket, message.id, `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`, "E_AMBIGUOUS_TARGET");
          break;
        }

        const disconnectedTargets = this.findDisconnectedSessions(clientMessage.to, fromSession.scopeId);
        if (disconnectedTargets.length === 1) {
          if (message.replyTo && !replyEdge) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
            break;
          }
          const disconnectedTarget = disconnectedTargets[0]!;
          const target = disconnectedTarget.info;
          const fingerprint = this.deliveryFingerprint(message, target.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            this.writeDeliveryFailure(socket, message.id, "Supersede target is not connected", "E_SUPERSEDE_TARGET");
            break;
          }
          if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== disconnectedTarget.key)) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
            break;
          }
          if (message.expectsReply) {
            this.writeDeliveryFailure(socket, message.id, "Target session is not currently connected; blocking asks are not queued", "E_TARGET_DISCONNECTED");
            break;
          }
          const liveMailboxTarget = this.findUniqueLiveSessionForDisconnectedSession(disconnectedTarget, currentKey);
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
            this.messageReceiptRoutes.set(message.id, { from: currentKey, to: liveMailboxTarget.key, createdAt: brokerReceivedAt });
          } else {
            this.queueMailboxMessage(fromSession, disconnectedTarget, message, brokerReceivedAt);
          }
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
            this.removePendingAskRecord(message.replyTo, fromSession.scopeId);
          }
          this.recordDelivery(currentKey, message.id, fingerprint, liveMailboxTarget ? "socket_delivered" : "queued");
          this.writeDeliverySuccess(socket, message.id, liveMailboxTarget ? "socket_delivered" : "queued");
          break;
        }

        if (disconnectedTargets.length > 1) {
          this.writeDeliveryFailure(socket, message.id, `Multiple disconnected sessions named \"${clientMessage.to}\" can receive queued mail. Use the session ID instead.`, "E_AMBIGUOUS_TARGET");
          break;
        }

        this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
        break;
      }

      case "message_receipt": {
        if (!currentKey) {
          throw new Error("Received message_receipt before register");
        }
        if (!isMessageReceipt(clientMessage.receipt)) {
          throw new Error("Invalid message_receipt message");
        }
        this.pruneMessageReceiptRoutes();
        const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId);
        const receiver = this.sessions.get(currentKey);
        const sender = route ? this.sessions.get(route.from) : undefined;
        if (route?.to === currentKey && receiver?.socket === socket && sender) {
          writeMessage(sender.socket, {
            type: "message_receipt",
            from: receiver.info,
            receipt: clientMessage.receipt,
          });
        }
        break;
      }

      case "cancel_message": {
        if (!currentKey) {
          throw new Error("Received cancel_message before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_message message");
        }
        this.pruneMessageReceiptRoutes();
        this.pruneMailboxMessages();
        const sender = this.sessions.get(currentKey);
        const queuedIndex = this.mailboxMessages.findIndex(entry => entry.message.id === clientMessage.messageId && entry.fromKey === currentKey);
        if (queuedIndex >= 0 && sender?.socket === socket) {
          this.mailboxMessages.splice(queuedIndex, 1);
          this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the queued delivery", "E_DELIVERY_CANCELLED");
          const edge = this.askEdges.get(clientMessage.messageId);
          if (edge?.from === currentKey) {
            this.askEdges.delete(clientMessage.messageId);
            this.removePendingAskRecord(clientMessage.messageId, sender.scopeId);
          }
          writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
          break;
        }
        const route = this.messageReceiptRoutes.get(clientMessage.messageId);
        const receiver = route ? this.sessions.get(route.to) : undefined;
        if (route?.from !== currentKey || sender?.socket !== socket || !receiver) {
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
        if (edge?.from === currentKey) {
          this.askEdges.delete(clientMessage.messageId);
          this.removePendingAskRecord(clientMessage.messageId, sender.scopeId);
        }
        this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the delivery", "E_DELIVERY_CANCELLED");
        writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
        break;
      }

      case "cancel_ask": {
        if (!currentKey) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentKey);
        const edge = this.askEdges.get(clientMessage.messageId);
        if (session?.socket === socket && edge?.from === currentKey) {
          this.askEdges.delete(clientMessage.messageId);
          this.removePendingAskRecord(clientMessage.messageId, session.scopeId);
        }
        break;
      }

      case "presence": {
        if (!currentKey) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentKey);
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
            this.broadcast({ type: "presence_update", session: session.info }, currentKey, session.scopeId);
          }
        }
        break;
      }

      case "extension_publish": {
        this.handleExtensionPublish(socket, currentKey, clientMessage);
        break;
      }

      case "extension_state_commit": {
        this.handleExtensionStateCommit(socket, currentKey, clientMessage);
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private rememberDisconnectedSession(session: ConnectedSession, now = Date.now()): void {
    this.disconnectedSessions.set(session.key, {
      info: { ...session.info },
      key: session.key,
      ...(session.scopeId ? { scopeId: session.scopeId } : {}),
      disconnectedAt: now,
    });
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
          this.removePendingAskRecord(entry.message.id, entry.fromScopeId);
        }
        this.messageReceiptRoutes.delete(entry.message.id);
        this.updateDeliveryRecord(entry.fromKey, entry.message.id, "failed", "Mailbox delivery expired", "E_DELIVERY_EXPIRED");
        this.mailboxMessages.splice(index, 1);
      }
    }
  }

  private queueMailboxMessage(from: ConnectedSession, target: DisconnectedSession, message: Message, brokerReceivedAt: number): void {
    this.pruneMailboxMessages(brokerReceivedAt);
    while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      const evicted = this.mailboxMessages.shift();
      if (!evicted) break;
      if (evicted.message.expectsReply) {
        this.askEdges.delete(evicted.message.id);
        this.removePendingAskRecord(evicted.message.id, evicted.fromScopeId);
      }
      this.messageReceiptRoutes.delete(evicted.message.id);
      this.updateDeliveryRecord(evicted.fromKey, evicted.message.id, "failed", "Mailbox capacity evicted the delivery", "E_DELIVERY_EVICTED");
    }
    this.mailboxMessages.push({
      from: { ...from.info },
      fromKey: from.key,
      ...(from.scopeId ? { fromScopeId: from.scopeId } : {}),
      target: { ...target.info },
      targetKey: target.key,
      ...(target.scopeId ? { targetScopeId: target.scopeId } : {}),
      message: { ...message, brokerReceivedAt },
      queuedAt: brokerReceivedAt,
    });
  }

  private writeDeliverySuccess(socket: net.Socket, messageId: string, delivery: "socket_delivered" | "queued"): void {
    writeMessage(socket, { type: "delivered", messageId, delivery, retryable: false, outcomeKnown: true });
  }

  private writeDeliveryFailure(socket: net.Socket, messageId: string, reason: string, code: string, retryable = false): void {
    writeMessage(socket, { type: "delivery_failed", messageId, reason, delivery: "failed", code, retryable, outcomeKnown: true });
  }

  private deliveryFingerprint(message: Message, targetId: string): string {
    return JSON.stringify({
      targetId,
      text: message.content.text,
      attachments: message.content.attachments,
      replyTo: message.replyTo,
      expectsReply: message.expectsReply,
      supersedes: message.supersedes,
      retryOf: message.retryOf,
    });
  }

  private deliveryRecordKey(fromSessionId: string, messageId: string): string {
    return JSON.stringify([fromSessionId, messageId]);
  }

  private replayOrReject(socket: net.Socket, fromSessionId: string, messageId: string, fingerprint: string): boolean {
    this.pruneDeliveryRecords();
    const record = this.deliveryRecords.get(this.deliveryRecordKey(fromSessionId, messageId));
    if (!record) return false;
    if (record.fingerprint !== fingerprint) {
      this.writeDeliveryFailure(socket, messageId, "Message id was reused with different authored content", "E_MESSAGE_ID_REUSE");
      return true;
    }
    if (record.code === "E_TARGET_REBOUND" && record.retryable) {
      return false;
    }
    if (record.state === "socket_delivered" || record.state === "queued") {
      this.writeDeliverySuccess(socket, messageId, record.state);
    } else {
      this.writeDeliveryFailure(socket, messageId, record.reason ?? "Previous delivery failed", record.code ?? "E_DELIVERY_FAILED", record.retryable);
    }
    return true;
  }

  private recordDelivery(fromSessionId: string, messageId: string, fingerprint: string, state: DeliveryState, reason?: string, code?: string, retryable = false): void {
    this.pruneDeliveryRecords();
    while (this.deliveryRecords.size >= MAX_DELIVERY_RECORDS) {
      const oldest = this.deliveryRecords.keys().next().value;
      if (oldest === undefined) break;
      this.deliveryRecords.delete(oldest);
    }
    this.deliveryRecords.set(this.deliveryRecordKey(fromSessionId, messageId), {
      fingerprint,
      state,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
      retryable,
      outcomeKnown: true,
      createdAt: Date.now(),
    });
  }

  private pruneDeliveryRecords(now = Date.now()): void {
    for (const [key, record] of this.deliveryRecords) {
      if (now - record.createdAt > DELIVERY_RECORD_RETENTION_MS) this.deliveryRecords.delete(key);
    }
  }

  private updateDeliveryRecord(fromSessionId: string, messageId: string, state: DeliveryState, reason?: string, code?: string): void {
    const record = this.deliveryRecords.get(this.deliveryRecordKey(fromSessionId, messageId));
    if (!record) return;
    record.state = state;
    record.reason = reason;
    record.code = code;
    record.retryable = false;
    record.outcomeKnown = true;
  }

  private flushMailboxForSession(session: ConnectedSession, now = Date.now()): void {
    this.pruneMailboxMessages(now);
    const sessionName = session.info.name?.toLowerCase();
    const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session).length === 1;

    for (let index = 0; index < this.mailboxMessages.length;) {
      const entry = this.mailboxMessages[index]!;
      if (!sameScope(entry.targetScopeId, session.scopeId)) {
        index += 1;
        continue;
      }
      const matchesId = entry.targetKey === session.key;
      const matchesSenderIdentity = Boolean(
        sessionName
        && sameScope(entry.fromScopeId, session.scopeId)
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
      if (edge?.to === entry.targetKey) {
        edge.to = session.key;
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
        from: entry.fromKey,
        to: session.key,
        createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
      });
      this.updateDeliveryRecord(entry.fromKey, entry.message.id, "socket_delivered");
    }
  }

  private pruneAskEdges(now = Date.now()): void {
    this.prunePendingAskRecords(now);
    for (const [messageId, edge] of this.askEdges) {
      if (now - edge.createdAt > this.askTimeoutMs) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId, edge.scopeId);
      }
    }
  }

  private clearAskEdgesForSession(sessionKey: string): void {
    for (const [messageId, edge] of this.askEdges) {
      if (edge.from === sessionKey || edge.to === sessionKey) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId, edge.scopeId);
      }
    }
  }

  private writePendingAskRecord(message: Message, from: ConnectedSession, target: SessionInfo, createdAt: number): void {
    ensurePendingAskRecordDir();
    const record: PendingAskRecord = {
      askId: message.id,
      messageId: message.id,
      asker: { sessionId: from.info.id, name: from.info.name ?? null },
      target: { sessionId: target.id, name: target.name ?? null },
      question: message.content.text,
      createdAt,
      expiresAt: createdAt + this.askTimeoutMs,
    };
    const filePath = scopedPendingAskRecordPath(from.scopeId, message.id);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
    restrictIntercomRuntimeFile(filePath);
  }

  private removePendingAskRecord(messageId: string, scopeId?: string): void {
    try {
      unlinkSync(scopedPendingAskRecordPath(scopeId, messageId));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private prunePendingAskRecords(now = Date.now()): void {
    ensurePendingAskRecordDir();
    for (const entry of readdirSync(PENDING_ASKS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = join(PENDING_ASKS_DIR, entry.name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        unlinkSync(filePath);
        continue;
      }
      if (!isPendingAskRecord(parsed) || now > parsed.expiresAt) {
        unlinkSync(filePath);
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

  private clearMessageReceiptRoutesForSession(sessionKey: string): void {
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (route.from === sessionKey || route.to === sessionKey) {
        this.messageReceiptRoutes.delete(messageId);
      }
    }
  }

  private findSessions(nameOrId: string, scopeId: string | undefined): ConnectedSession[] {
    const byId = this.sessions.get(scopedSessionKey(scopeId, nameOrId));
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(session => sameScope(session.scopeId, scopeId) && session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.sessions.entries())
      .filter(([, session]) => sameScope(session.scopeId, scopeId) && session.info.id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findDisconnectedSessions(nameOrId: string, scopeId: string | undefined): DisconnectedSession[] {
    this.pruneDisconnectedSessions();
    const byId = this.disconnectedSessions.get(scopedSessionKey(scopeId, nameOrId));
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.disconnectedSessions.values()).filter(session => sameScope(session.scopeId, scopeId) && session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.disconnectedSessions.entries())
      .filter(([, session]) => sameScope(session.scopeId, scopeId) && session.info.id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findUniqueLiveSessionForDisconnectedSession(disconnected: DisconnectedSession, senderKey?: string): ConnectedSession | null {
    const matches = this.findLiveSessionsSharingMailboxIdentity(disconnected)
      .filter((session) => session.key !== senderKey);
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
  private findLiveSessionsSharingMailboxIdentity(sessionInfo: ConnectedSession | DisconnectedSession): ConnectedSession[] {
    const lowerName = sessionInfo.info.name?.toLowerCase();
    if (!lowerName || sessionInfo.info.runtimeFallbackAlias) {
      return [];
    }
    return Array.from(this.sessions.values()).filter(session =>
      sameScope(session.scopeId, sessionInfo.scopeId)
      && !session.info.runtimeFallbackAlias
      && session.info.name?.toLowerCase() === lowerName
      && sameCwd(session.info.cwd, sessionInfo.info.cwd)
    );
  }

  private broadcast(msg: BrokerMessage, exclude?: string, scopeId?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && sameScope(session.scopeId, scopeId)) {
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
    const namespaces = new Map<string, { namespace: string; scopeId?: string }>();
    for (const [key, owner] of this.namespaceOwners) {
      namespaces.set(key, {
        namespace: owner.namespace,
        ...(owner.scopeId ? { scopeId: owner.scopeId } : {}),
      });
    }
    for (const session of this.sessions.values()) {
      for (const extension of session.extensions ?? []) {
        namespaces.set(scopedExtensionKey(session.scopeId, extension.namespace), {
          namespace: extension.namespace,
          ...(session.scopeId ? { scopeId: session.scopeId } : {}),
        });
      }
    }

    // For each namespace, elect owner by (startedAt, sessionId).
    for (const [namespaceKey, scopedNamespace] of namespaces) {
      const { namespace, scopeId } = scopedNamespace;
      const candidates: Array<{ sessionKey: string; session: ConnectedSession }> = [];
      for (const [sessionKey, session] of this.sessions) {
        if (session.extensions) {
          const hasNamespace = session.extensions.some(
            (ext) => sameScope(session.scopeId, scopeId) && ext.namespace === namespace && ext.ownerEligible
          );
          if (hasNamespace) {
            candidates.push({ sessionKey, session });
          }
        }
      }

      if (candidates.length === 0) {
        if (this.namespaceOwners.delete(namespaceKey)) {
          for (const session of this.sessions.values()) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions?.some((extension) => extension.namespace === namespace);
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
        return a.session.info.id.localeCompare(b.session.info.id);
      });

      const winner = candidates[0];
      const existing = this.namespaceOwners.get(namespaceKey);

      const ownerChanged = !existing || existing.sessionKey !== winner.sessionKey;
      const socketChanged = existing && existing.socket !== winner.session.socket;

      if (ownerChanged || socketChanged) {
        const epoch = randomUUID();
        this.namespaceOwners.set(namespaceKey, {
          namespace,
          sessionKey: winner.sessionKey,
          sessionId: winner.session.info.id,
          socket: winner.session.socket,
          epoch,
          ...(scopeId ? { scopeId } : {}),
        });

        for (const session of this.sessions.values()) {
          if (session.extensions?.length) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions.some((ext) => ext.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, {
                type: "extension_owner",
                namespace,
                ownerId: winner.session.info.id,
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
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_publish before register");
    }

    const session = this.sessions.get(currentKey);
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

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
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
      if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
        writeMessage(socket, { type: "error", error: "Owner validation failed" });
        return;
      }
    }

    // Route message to appropriate audience
    for (const [recipientId, recipientSession] of this.sessions) {
      if (!sameScope(recipientSession.scopeId, session.scopeId)) {
        continue;
      }
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
          recipientId === owner.sessionKey &&
          recipientSession.socket === owner.socket);

      if (shouldReceive) {
        writeMessage(recipientSession.socket, {
          type: "extension_message",
          namespace,
          fromSessionId: session.info.id,
          ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          payload,
        });
      }
    }
  }

  private handleExtensionStateCommit(
    socket: net.Socket,
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_state_commit before register");
    }

    const session = this.sessions.get(currentKey);
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
    const stateNamespace = scopedExtensionStateNamespace(session.scopeId, namespace);

    if (typeof ownerEpoch !== "string") {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid ownerEpoch",
      });
      return;
    }

    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
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
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
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
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Sender does not have capability for this namespace",
      });
      return;
    }

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
    if (!owner) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "No owner for this namespace",
      });
      return;
    }

    // Validate owner, socket, and epoch
    if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Owner validation failed",
      });
      return;
    }

    const result = this.extensionStateManager.commitState(stateNamespace, expectedRevision, payload);

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
        if (!sameScope(recipientSession.scopeId, session.scopeId)) {
          continue;
        }
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
