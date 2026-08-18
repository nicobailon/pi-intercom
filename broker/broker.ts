import net from "net";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { isChannelAddress, isChannelInfo, isMessage, isMessageReceipt, isSessionId, isSessionRegistration } from "./protocol.ts";
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
import { CHANNEL_BUS_FEATURE, EXTENSION_BUS_FEATURE } from "../types.ts";
import type {
  ChannelAddress,
  ChannelInfo,
  ChannelLifecycle,
  DeliveryState,
  SessionInfo,
  Message,
  BrokerMessage,
  ExtensionCapability,
  MessageControl,
} from "../types.ts";
import {
  channelAddress,
  channelForPair,
  channelMemberById,
  channelMemberForSession,
  cloneChannel,
  createPairChannel,
  isChannelExpired,
  touchChannel,
} from "./channel.ts";
import { ExtensionStateManager } from "./extension-state.ts";
import { assertNoLiveBroker } from "./runtime-claim.ts";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const PENDING_ASKS_DIR = join(INTERCOM_DIR, "pending-asks");
const CHANNELS_STATE_PATH = join(INTERCOM_DIR, "channels.json");
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

function mailboxMessageRetentionMs(): number {
  const configured = Number.parseInt(process.env.PI_INTERCOM_MAILBOX_MESSAGE_RETENTION_MS ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : MAILBOX_MESSAGE_RETENTION_MS;
}
const MAX_CHANNELS = 1024;
const MAX_CHANNEL_MESSAGE_RECORDS = 4096;

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
  disconnectedAt: number;
}

interface MailboxMessage {
  from: SessionInfo;
  target: SessionInfo;
  message: Message;
  queuedAt: number;
  channel?: ChannelAddress;
}

type ChannelMessageState = DeliveryState | "cancelled" | "expired" | "superseded";

interface ChannelMessageRecord {
  fingerprint: string;
  channelId: string;
  fromMemberId: string;
  toMemberId: string;
  state: ChannelMessageState;
  createdAt: number;
  message: Message;
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

export class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private askEdges = new Map<string, AskEdge>();
  private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
  private disconnectedSessions = new Map<string, DisconnectedSession>();
  private mailboxMessages: MailboxMessage[] = [];
  private channels = new Map<string, ChannelInfo>();
  private channelMessageRecords = new Map<string, ChannelMessageRecord>();
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
    this.loadChannels();
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
    let socketHardeningAttempts = 0;
    const onListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        // Node can emit `listening` one tick before the Unix socket directory
        // entry is visible on some macOS filesystems. Retry the permission
        // hardening instead of crashing the broker during startup.
        if (!existsSync(LISTEN_TARGET)) {
          socketHardeningAttempts += 1;
          if (socketHardeningAttempts > 100) {
            throw new Error(`Intercom broker socket did not become visible at ${LISTEN_TARGET}`);
          }
          setTimeout(onListening, 5).unref?.();
          return;
        }
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
          this.markChannelsOffline(sessionId);
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

        const now = Date.now();
        this.pruneDisconnectedSessions(now);
        this.pruneChannels(now);
        this.pruneMailboxMessages(now);
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
          ...(session.tmuxPane !== undefined ? { tmuxPane: session.tmuxPane } : {}),
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
        this.rebindChannelsForSession(connectedSession, now);
        
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
          features: [EXTENSION_BUS_FEATURE, CHANNEL_BUS_FEATURE],
        });
        this.broadcast({ type: "session_joined", session: info }, id);

        this.recomputeNamespaceOwners();
        this.flushMailboxForSession(connectedSession, now);

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
          this.markChannelsOffline(currentId);
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

      case "channel_open": {
        this.handleChannelOpen(socket, currentId, clientMessage);
        break;
      }

      case "channel_close": {
        this.handleChannelClose(socket, currentId, clientMessage);
        break;
      }

      case "channel_send": {
        this.handleChannelSend(socket, currentId, clientMessage);
        break;
      }

      case "send": {
        // Legacy clients are upgraded only when they address an exact session
        // ID. Name/prefix routing never crosses into the broker delivery seam.
        if (this.handleLegacySend(socket, currentId, clientMessage)) {
          break;
        }
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
            this.writePendingAskRecord(message, fromSession.info, target.info, brokerReceivedAt);
            this.askEdges.set(message.id, { from: currentId, to: target.info.id, createdAt: brokerReceivedAt });
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
            this.removePendingAskRecord(message.replyTo);
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
            this.removePendingAskRecord(message.replyTo);
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
          const [entry] = this.mailboxMessages.splice(queuedIndex, 1);
          if (entry) this.terminalizeMailboxEntry(entry, "cancelled");
          const edge = this.askEdges.get(clientMessage.messageId);
          if (edge?.from === currentId) {
            this.askEdges.delete(clientMessage.messageId);
            this.removePendingAskRecord(clientMessage.messageId);
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
          this.removePendingAskRecord(clientMessage.messageId);
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
          this.removePendingAskRecord(clientMessage.messageId);
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

  private loadChannels(): void {
    try {
      if (!existsSync(CHANNELS_STATE_PATH)) {
        return;
      }
      const parsed: unknown = JSON.parse(readFileSync(CHANNELS_STATE_PATH, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.channels)) return;
      for (const value of parsed.channels) {
        if (isChannelInfo(value)) {
          this.channels.set(value.channelId, cloneChannel(value));
        }
      }
      this.pruneChannels(Date.now(), false);
    } catch (error) {
      // A corrupt optional channel state must not prevent ordinary intercom
      // startup. It is quarantined by ignoring it; the next channel open will
      // create a fresh epoch rather than risk reusing ambiguous membership.
      console.error(`Failed to load intercom channels: ${error instanceof Error ? error.message : String(error)}`);
      this.channels.clear();
    }
  }

  private persistChannels(): void {
    try {
      const payload = JSON.stringify({ version: 1, channels: [...this.channels.values()] }, null, 2);
      const tempPath = `${CHANNELS_STATE_PATH}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${payload}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(tempPath);
      renameSync(tempPath, CHANNELS_STATE_PATH);
      restrictIntercomRuntimeFile(CHANNELS_STATE_PATH);
    } catch (error) {
      console.error(`Failed to persist intercom channels: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pruneChannels(now = Date.now(), persist = true): void {
    let changed = false;
    for (const channel of this.channels.values()) {
      if (channel.state === "active" && isChannelExpired(channel, now)) {
        channel.state = "expired";
        changed = true;
      }
    }
    if (changed && persist) this.persistChannels();
  }

  private markChannelsOffline(sessionId: string, now = Date.now()): void {
    let changed = false;
    for (const channel of this.channels.values()) {
      for (const member of channel.members) {
        if (member.sessionId === sessionId && member.state === "online") {
          member.state = "offline";
          member.lastSeenAt = now;
          changed = true;
        }
      }
    }
    if (changed) this.persistChannels();
  }

  private rebindChannelsForSession(session: ConnectedSession, now = Date.now()): void {
    let changed = false;
    for (const channel of this.channels.values()) {
      if (channel.state !== "active") continue;
      for (const member of channel.members) {
        if (member.sessionId !== session.info.id || member.state === "left") continue;
        // A reconnect is a new endpoint binding even when the stable session
        // ID is retained. Callers must refresh the channel handshake before
        // sending, so an old socket cannot silently receive new traffic.
        member.bindingEpoch = randomUUID();
        member.state = "online";
        member.lastSeenAt = now;
        changed = true;
      }
    }
    if (changed) this.persistChannels();
  }

  private channelError(
    socket: net.Socket,
    messageId: string,
    reason: string,
    code: string,
    options: { retryable?: boolean; outcomeKnown?: boolean; channelId?: string } = {},
  ): void {
    writeMessage(socket, {
      type: "delivery_failed",
      messageId,
      reason,
      code,
      retryable: options.retryable ?? false,
      outcomeKnown: options.outcomeKnown ?? true,
      ...(options.channelId ? { channelId: options.channelId } : {}),
    });
  }

  private channelOpenError(
    socket: net.Socket,
    requestId: string,
    reason: string,
    code: string,
    retryable = false,
  ): void {
    writeMessage(socket, { type: "channel_open_failed", requestId, reason, code, retryable });
  }

  private sessionInfoForChannel(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId)?.info
      ?? this.disconnectedSessions.get(sessionId)?.info
      ?? null;
  }

  private isCurrentSessionSocket(sessionId: string | null, socket: net.Socket): boolean {
    return Boolean(sessionId && this.sessions.get(sessionId)?.socket === socket);
  }

  private getOrCreatePairChannel(
    senderId: string,
    targetId: string,
    lifecycle: ChannelLifecycle = "ephemeral",
    now = Date.now(),
  ): ChannelInfo {
    this.pruneChannels(now);
    const existing = channelForPair(this.channels.values(), senderId, targetId);
    if (existing) {
      touchChannel(existing, now);
      for (const member of existing.members) {
        if (member.sessionId === senderId && this.sessions.has(senderId)) member.state = "online";
        if (member.sessionId === targetId && this.sessions.has(targetId)) member.state = "online";
      }
      this.persistChannels();
      return existing;
    }
    if (this.channels.size >= MAX_CHANNELS) {
      throw Object.assign(new Error("E_CHANNEL_LIMIT: too many active channels"), { code: "E_CHANNEL_LIMIT" });
    }
    const sender = this.sessionInfoForChannel(senderId);
    const target = this.sessionInfoForChannel(targetId);
    if (!sender || !target) {
      throw Object.assign(new Error("E_TARGET_NOT_FOUND: Session not found; target session is not connected or known"), { code: "E_TARGET_NOT_FOUND" });
    }
    let channel: ChannelInfo;
    try {
      channel = createPairChannel(sender, target, lifecycle, now);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: "E_NAME_CONFLICT" });
    }
    if (!this.sessions.has(targetId)) {
      const targetMember = channelMemberForSession(channel, targetId);
      if (targetMember) targetMember.state = "offline";
    }
    this.channels.set(channel.channelId, channel);
    this.persistChannels();
    return channel;
  }

  private handleChannelOpen(socket: net.Socket, currentId: string | null, msg: Record<string, unknown>): void {
    if (!currentId) throw new Error("Received channel_open before register");
    const requestId = msg.requestId;
    const targetSessionId = msg.targetSessionId;
    const lifecycle = msg.lifecycle === undefined ? "ephemeral" : msg.lifecycle;
    if (typeof requestId !== "string" || requestId.length === 0 || typeof targetSessionId !== "string" || targetSessionId.length === 0) {
      throw new Error("Invalid channel_open message");
    }
    if (!this.isCurrentSessionSocket(currentId, socket)) {
      this.channelOpenError(socket, requestId, "E_SESSION_REPLACED: this socket is no longer the current session endpoint", "E_SESSION_REPLACED");
      return;
    }
    if (targetSessionId === currentId) {
      this.channelOpenError(socket, requestId, "E_TARGET_SELF: a channel needs two different sessions", "E_TARGET_SELF");
      return;
    }
    if (lifecycle !== "ephemeral" && lifecycle !== "reusable") {
      this.channelOpenError(socket, requestId, "E_CHANNEL_LIFECYCLE: lifecycle must be ephemeral or reusable", "E_CHANNEL_LIFECYCLE");
      return;
    }
    try {
      const channel = this.getOrCreatePairChannel(currentId, targetSessionId, lifecycle as ChannelLifecycle);
      const self = channelMemberForSession(channel, currentId);
      const target = channel.members.find((member) => member.sessionId === targetSessionId && member.state !== "left");
      if (!self || !target) {
        this.channelOpenError(socket, requestId, "E_MEMBER_NOT_FOUND: channel membership is incomplete", "E_MEMBER_NOT_FOUND");
        return;
      }
      writeMessage(socket, {
        type: "channel_opened",
        requestId,
        channel: cloneChannel(channel),
        selfMemberId: self.memberId,
        targetMemberId: target.memberId,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.channelOpenError(socket, requestId, error instanceof Error ? error.message : String(error), typeof code === "string" ? code : "E_CHANNEL_OPEN", code === "E_TARGET_NOT_FOUND");
    }
  }

  private handleChannelClose(socket: net.Socket, currentId: string | null, msg: Record<string, unknown>): void {
    if (!currentId) throw new Error("Received channel_close before register");
    const requestId = msg.requestId;
    const channelId = msg.channelId;
    const channelEpoch = msg.channelEpoch;
    if (typeof requestId !== "string" || typeof channelId !== "string" || typeof channelEpoch !== "string") {
      throw new Error("Invalid channel_close message");
    }
    if (!this.isCurrentSessionSocket(currentId, socket)) {
      this.channelOpenError(socket, requestId, "E_SESSION_REPLACED: this socket is no longer the current session endpoint", "E_SESSION_REPLACED");
      return;
    }
    const channel = this.channels.get(channelId);
    const member = channel ? channelMemberForSession(channel, currentId) : undefined;
    if (!channel || channel.epoch !== channelEpoch || !member) {
      this.channelOpenError(socket, requestId, "E_CHANNEL_NOT_FOUND: channel close authorization failed", "E_CHANNEL_NOT_FOUND");
      return;
    }
    channel.state = "closed";
    this.persistChannels();
    writeMessage(socket, { type: "channel_closed", requestId, channelId });
  }

  private messageRecordKey(address: ChannelAddress, messageId: string): string {
    return `${address.channelId}\0${address.fromMemberId}\0${messageId}`;
  }

  private messageFingerprint(message: Message): string {
    const {
      timestamp: _timestamp,
      senderSequence: _senderSequence,
      brokerReceivedAt: _brokerReceivedAt,
      brokerDeliveredAt: _brokerDeliveredAt,
      receiverReceivedAt: _receiverReceivedAt,
      injectedAt: _injectedAt,
      channel: rawChannel,
      ...authoredMessage
    } = message;
    const channel = rawChannel
      ? { ...rawChannel, targetBindingEpoch: "<binding>" }
      : undefined;
    return createHash("sha256").update(JSON.stringify({ ...authoredMessage, channel })).digest("hex");
  }

  private pruneChannelMessageRecords(now = Date.now()): void {
    for (const [key, record] of this.channelMessageRecords) {
      const channel = this.channels.get(record.channelId);
      if (!channel || (channel.expiresAt !== undefined && channel.expiresAt < now - mailboxMessageRetentionMs())) {
        this.channelMessageRecords.delete(key);
      }
    }
    while (this.channelMessageRecords.size > MAX_CHANNEL_MESSAGE_RECORDS) {
      const oldest = this.channelMessageRecords.keys().next().value;
      if (typeof oldest !== "string") break;
      this.channelMessageRecords.delete(oldest);
    }
  }

  private sendChannelSuccess(socket: net.Socket, messageId: string, state: DeliveryState, channelId: string): void {
    writeMessage(socket, { type: "delivered", messageId, state, channelId });
  }

  private terminalizeMailboxEntry(entry: MailboxMessage, state: Extract<ChannelMessageState, "cancelled" | "expired" | "superseded">): void {
    if (entry.channel) {
      const key = this.messageRecordKey(entry.channel, entry.message.id);
      const record = this.channelMessageRecords.get(key);
      if (record && record.state === "queued") {
        record.state = state;
      }
    }
    if (entry.message.expectsReply) {
      this.askEdges.delete(entry.message.id);
      this.removePendingAskRecord(entry.message.id);
    }
    this.messageReceiptRoutes.delete(entry.message.id);
  }

  private removeQueuedChannelMessage(
    channelId: string,
    fromMemberId: string,
    toMemberId: string,
    messageId: string,
    state: Extract<ChannelMessageState, "superseded" | "cancelled" | "expired">,
  ): boolean {
    const index = this.mailboxMessages.findIndex((entry) => {
      return entry.message.id === messageId
        && entry.channel?.channelId === channelId
        && entry.channel.fromMemberId === fromMemberId
        && entry.channel.toMemberId === toMemberId;
    });
    if (index < 0) return false;
    const [entry] = this.mailboxMessages.splice(index, 1);
    if (entry) this.terminalizeMailboxEntry(entry, state);
    return Boolean(entry);
  }

  private channelRecordFailure(
    socket: net.Socket,
    messageId: string,
    record: ChannelMessageRecord,
  ): void {
    const terminal = record.state === "cancelled" || record.state === "expired" || record.state === "superseded"
      ? record.state
      : "failed";
    const code = terminal === "cancelled"
      ? "E_MESSAGE_CANCELLED"
      : terminal === "expired"
        ? "E_MESSAGE_EXPIRED"
        : terminal === "superseded"
          ? "E_MESSAGE_SUPERSEDED"
          : "E_DELIVERY_FAILED";
    this.channelError(
      socket,
      messageId,
      `${code}: previous message record is terminal (${terminal})`,
      code,
      { channelId: record.channelId },
    );
  }

  private handleChannelSend(socket: net.Socket, currentId: string | null, msg: Record<string, unknown>): void {
    if (!currentId) throw new Error("Received channel_send before register");
    const address = msg.channel;
    const message = msg.message;
    const messageId = isMessage(message) ? message.id : "unknown";
    if (!isChannelAddress(address) || !isMessage(message) || !message.channel || JSON.stringify(address) !== JSON.stringify(message.channel)) {
      this.channelError(socket, messageId, "E_CHANNEL_MESSAGE_FORMAT: channel address and message metadata must match", "E_CHANNEL_MESSAGE_FORMAT");
      return;
    }
    this.routeChannelMessage(socket, currentId, address, message);
  }

  private handleLegacySend(socket: net.Socket, currentId: string | null, msg: Record<string, unknown>): boolean {
    const message = msg.message;
    const messageId = isMessage(message) ? message.id : "unknown";
    if (!currentId || typeof msg.to !== "string" || !isMessage(message)) return false;
    if (!this.isCurrentSessionSocket(currentId, socket)) {
      this.channelError(socket, messageId, "E_SESSION_REPLACED: this socket is no longer the current session endpoint", "E_SESSION_REPLACED");
      return true;
    }
    const targetId = msg.to;
    // Legacy wire clients cannot safely express a channel-local name. Exact
    // IDs are upgraded; fuzzy names/prefixes fail closed with a useful code.
    const target = this.sessions.get(targetId) ?? this.disconnectedSessions.get(targetId);
    if (!target || target.info.id !== targetId) {
      this.channelError(socket, messageId, "E_CHANNEL_REQUIRED: resolve an exact session ID and establish channel-v1 before sending", "E_CHANNEL_REQUIRED");
      return true;
    }
    try {
      const channel = this.getOrCreatePairChannel(currentId, targetId);
      const fromMember = channelMemberForSession(channel, currentId);
      const toMember = channelMemberForSession(channel, targetId);
      if (!fromMember || !toMember) throw new Error("E_MEMBER_NOT_FOUND: channel membership is incomplete");
      const address = channelAddress(channel, fromMember, toMember);
      this.routeChannelMessage(socket, currentId, address, { ...message, channel: address });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.channelError(socket, messageId, error instanceof Error ? error.message : String(error), typeof code === "string" ? code : "E_CHANNEL_REQUIRED");
    }
    return true;
  }

  private routeChannelMessage(socket: net.Socket, currentId: string, address: ChannelAddress, message: Message): void {
    this.pruneChannels();
    this.pruneMailboxMessages();
    this.pruneChannelMessageRecords();
    const channel = this.channels.get(address.channelId);
    const messageId = message.id;
    if (!channel) {
      this.channelError(socket, messageId, "E_CHANNEL_NOT_FOUND: channel does not exist", "E_CHANNEL_NOT_FOUND");
      return;
    }
    if (channel.state !== "active") {
      this.channelError(socket, messageId, `E_CHANNEL_${channel.state.toUpperCase()}: channel is not active`, `E_CHANNEL_${channel.state.toUpperCase()}`);
      return;
    }
    if (channel.epoch !== address.channelEpoch) {
      this.channelError(socket, messageId, "E_CHANNEL_STALE_EPOCH: channel epoch is stale", "E_CHANNEL_STALE_EPOCH");
      return;
    }
    const fromMember = channelMemberById(channel, address.fromMemberId);
    const targetMember = channelMemberById(channel, address.toMemberId);
    const sender = this.sessions.get(currentId);
    if (!sender || sender.socket !== socket || !fromMember || fromMember.sessionId !== currentId || fromMember.state !== "online") {
      this.channelError(socket, messageId, "E_SENDER_NOT_MEMBER: sender is not the bound channel member", "E_SENDER_NOT_MEMBER");
      return;
    }
    if (!targetMember || targetMember.state === "left" || targetMember.memberId === fromMember.memberId) {
      this.channelError(socket, messageId, "E_TARGET_NOT_MEMBER: target is not a channel member", "E_TARGET_NOT_MEMBER", { channelId: channel.channelId });
      return;
    }
    const recordKey = this.messageRecordKey(address, messageId);
    const fingerprint = this.messageFingerprint(message);
    const existing = this.channelMessageRecords.get(recordKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.toMemberId !== targetMember.memberId) {
        this.channelError(socket, messageId, "E_MESSAGE_ID_REUSE: message ID was already used for different content or recipient", "E_MESSAGE_ID_REUSE", { channelId: channel.channelId });
      } else if (existing.state === "queued" || existing.state === "socket_delivered") {
        this.sendChannelSuccess(socket, messageId, existing.state, channel.channelId);
      } else {
        this.channelRecordFailure(socket, messageId, existing);
      }
      return;
    }
    if (address.targetBindingEpoch !== targetMember.bindingEpoch) {
      this.channelError(socket, messageId, "E_TARGET_REBOUND: target endpoint binding changed; reopen the channel and retry deliberately", "E_TARGET_REBOUND", { retryable: true, channelId: channel.channelId });
      return;
    }

    const brokerReceivedAt = Date.now();
    this.pruneAskEdges(brokerReceivedAt);
    this.pruneMessageReceiptRoutes(brokerReceivedAt);
    const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;
    const target = this.sessions.get(targetMember.sessionId);
    if (message.replyTo && (!replyEdge || replyEdge.to !== currentId || replyEdge.from !== targetMember.sessionId)) {
      this.channelError(socket, messageId, "E_REPLY_CHANNEL_MISMATCH: reply does not match a pending ask in this channel", "E_REPLY_CHANNEL_MISMATCH", { channelId: channel.channelId });
      return;
    }
    if (message.supersedes) {
      const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
      if (!supersededRoute || supersededRoute.from !== currentId || supersededRoute.to !== targetMember.sessionId) {
        this.channelError(socket, messageId, "E_SUPERSEDE_TARGET: supersede target does not match a previous message from the same sender and receiver", "E_SUPERSEDE_TARGET", { channelId: channel.channelId });
        return;
      }
    }
    if (message.expectsReply) {
      const reverseEdge = Array.from(this.askEdges.entries()).find(([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === targetMember.sessionId && edge.to === currentId);
      if (reverseEdge) {
        this.channelError(socket, messageId, "Mutual ask refused: target session is already waiting for a reply from this session.", "E_MUTUAL_ASK", { channelId: channel.channelId });
        return;
      }
      if (!target) {
        this.channelError(socket, messageId, "E_TARGET_OFFLINE: target session is not currently connected; blocking asks are not queued", "E_TARGET_OFFLINE", { retryable: true, channelId: channel.channelId });
        return;
      }
      this.writePendingAskRecord(message, sender.info, target.info, brokerReceivedAt);
      this.askEdges.set(message.id, { from: currentId, to: targetMember.sessionId, createdAt: brokerReceivedAt });
    }

    const deliveredMessage: Message = {
      ...message,
      channel: { ...address, targetBindingEpoch: targetMember.bindingEpoch },
      channelSenderName: fromMember.agentName,
      channelTargetName: targetMember.agentName,
      brokerReceivedAt,
      ...(target ? { brokerDeliveredAt: Date.now() } : {}),
    };
    if (target) {
      try {
        if (message.supersedes) {
          writeMessage(target.socket, {
            type: "message_control",
            from: sender.info,
            control: { action: "supersede", messageId: message.supersedes, supersededBy: message.id, timestamp: Date.now() },
          });
        }
        writeMessage(target.socket, { type: "message", from: sender.info, message: deliveredMessage });
      } catch (error) {
        if (message.expectsReply) {
          this.askEdges.delete(message.id);
          this.removePendingAskRecord(message.id);
        }
        this.channelError(socket, messageId, `E_DELIVERY_UNKNOWN: broker could not confirm socket write (${error instanceof Error ? error.message : String(error)})`, "E_DELIVERY_UNKNOWN", { retryable: false, outcomeKnown: false, channelId: channel.channelId });
        return;
      }
      if (message.replyTo) {
        this.askEdges.delete(message.replyTo);
        this.removePendingAskRecord(message.replyTo);
      }
      this.messageReceiptRoutes.set(message.id, { from: currentId, to: targetMember.sessionId, createdAt: brokerReceivedAt });
      this.channelMessageRecords.set(recordKey, { fingerprint, channelId: channel.channelId, fromMemberId: fromMember.memberId, toMemberId: targetMember.memberId, state: "socket_delivered", createdAt: brokerReceivedAt, message: deliveredMessage });
      touchChannel(channel, brokerReceivedAt);
      this.persistChannels();
      this.sendChannelSuccess(socket, messageId, "socket_delivered", channel.channelId);
      return;
    }

    if (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      if (message.expectsReply) {
        this.askEdges.delete(message.id);
        this.removePendingAskRecord(message.id);
      }
      this.channelError(socket, messageId, "E_QUEUE_FULL: channel mailbox is full", "E_QUEUE_FULL", { retryable: true, channelId: channel.channelId });
      return;
    }
    if (message.supersedes) {
      this.removeQueuedChannelMessage(
        channel.channelId,
        fromMember.memberId,
        targetMember.memberId,
        message.supersedes,
        "superseded",
      );
    }
    this.queueMailboxMessage(sender.info, targetMember.sessionId ? (this.disconnectedSessions.get(targetMember.sessionId)?.info ?? { ...sender.info, id: targetMember.sessionId }) : sender.info, deliveredMessage, brokerReceivedAt, address);
    this.messageReceiptRoutes.set(message.id, { from: currentId, to: targetMember.sessionId, createdAt: brokerReceivedAt });
    this.channelMessageRecords.set(recordKey, { fingerprint, channelId: channel.channelId, fromMemberId: fromMember.memberId, toMemberId: targetMember.memberId, state: "queued", createdAt: brokerReceivedAt, message: deliveredMessage });
    if (message.replyTo) {
      this.askEdges.delete(message.replyTo);
      this.removePendingAskRecord(message.replyTo);
    }
    touchChannel(channel, brokerReceivedAt);
    this.persistChannels();
    this.sendChannelSuccess(socket, messageId, "queued", channel.channelId);
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
      if (now - entry.queuedAt > mailboxMessageRetentionMs()) {
        this.terminalizeMailboxEntry(entry, "expired");
        this.mailboxMessages.splice(index, 1);
      }
    }
  }

  private queueMailboxMessage(from: SessionInfo, target: SessionInfo, message: Message, brokerReceivedAt: number, channel?: ChannelAddress): void {
    this.pruneMailboxMessages(brokerReceivedAt);
    while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      const evicted = this.mailboxMessages.shift();
      if (!evicted) break;
      this.terminalizeMailboxEntry(evicted, "expired");
    }
    this.mailboxMessages.push({
      from: { ...from },
      target: { ...target },
      message: { ...message, brokerReceivedAt },
      queuedAt: brokerReceivedAt,
      ...(channel ? { channel: { ...channel } } : {}),
    });
  }

  private flushMailboxForSession(session: ConnectedSession, now = Date.now()): void {
    this.pruneMailboxMessages(now);
    const sessionName = session.info.name?.toLowerCase();
    const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session.info).length === 1;

    for (let index = 0; index < this.mailboxMessages.length;) {
      const entry = this.mailboxMessages[index]!;
      if (entry.channel) {
        const channel = this.channels.get(entry.channel.channelId);
        const targetMember = channel ? channelMemberById(channel, entry.channel.toMemberId) : undefined;
        if (!channel || channel.state !== "active" || !targetMember || targetMember.sessionId !== session.info.id) {
          if (channel && isChannelExpired(channel, now)) {
            this.terminalizeMailboxEntry(entry, "expired");
            this.mailboxMessages.splice(index, 1);
            continue;
          }
          index += 1;
          continue;
        }
        const edge = this.askEdges.get(entry.message.id);
        if (edge?.to === entry.target.id) edge.to = session.info.id;
        const refreshedAddress = { ...entry.channel, targetBindingEpoch: targetMember.bindingEpoch };
        const deliveredMessage: Message = {
          ...entry.message,
          channel: refreshedAddress,
          channelSenderName: entry.message.channelSenderName ?? channelMemberById(channel, entry.channel.fromMemberId)?.agentName,
          channelTargetName: targetMember.agentName,
          brokerDeliveredAt: Date.now(),
        };
        try {
          writeMessage(session.socket, { type: "message", from: entry.from, message: deliveredMessage });
        } catch {
          index += 1;
          continue;
        }
        this.mailboxMessages.splice(index, 1);
        const key = this.messageRecordKey(entry.channel, entry.message.id);
        const record = this.channelMessageRecords.get(key);
        if (record) {
          record.state = "socket_delivered";
          record.message = deliveredMessage;
        }
        targetMember.state = "online";
        targetMember.lastSeenAt = now;
        touchChannel(channel, now);
        this.messageReceiptRoutes.set(entry.message.id, {
          from: entry.from.id,
          to: session.info.id,
          createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
        });
        this.persistChannels();
        continue;
      }
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

      const edge = this.askEdges.get(entry.message.id);
      if (edge?.to === entry.target.id) {
        edge.to = session.info.id;
      }
      const deliveredMessage: Message = {
        ...entry.message,
        brokerDeliveredAt: Date.now(),
      };
      try {
        writeMessage(session.socket, {
          type: "message",
          from: entry.from,
          message: deliveredMessage,
        });
      } catch {
        index += 1;
        continue;
      }
      this.mailboxMessages.splice(index, 1);
      this.messageReceiptRoutes.set(entry.message.id, {
        from: entry.from.id,
        to: session.info.id,
        createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
      });
    }
  }

  private pruneAskEdges(now = Date.now()): void {
    this.prunePendingAskRecords(now);
    for (const [messageId, edge] of this.askEdges) {
      if (now - edge.createdAt > this.askTimeoutMs) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId);
      }
    }
  }

  private clearAskEdgesForSession(sessionId: string): void {
    for (const [messageId, edge] of this.askEdges) {
      if (edge.from === sessionId || edge.to === sessionId) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId);
      }
    }
  }

  private writePendingAskRecord(message: Message, from: SessionInfo, target: SessionInfo, createdAt: number): void {
    ensurePendingAskRecordDir();
    const record: PendingAskRecord = {
      askId: message.id,
      messageId: message.id,
      asker: { sessionId: from.id, name: from.name ?? null },
      target: { sessionId: target.id, name: target.name ?? null },
      question: message.content.text,
      createdAt,
      expiresAt: createdAt + this.askTimeoutMs,
    };
    const filePath = pendingAskRecordPath(message.id);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
    restrictIntercomRuntimeFile(filePath);
  }

  private removePendingAskRecord(messageId: string): void {
    try {
      unlinkSync(pendingAskRecordPath(messageId));
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
      !session.info.runtimeFallbackAlias
      && session.info.name?.toLowerCase() === lowerName
      && sameCwd(session.info.cwd, info.cwd)
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

      const ownerChanged = !existing || existing.sessionId !== winner.sessionId;
      const socketChanged = existing && existing.socket !== winner.session.socket;

      if (ownerChanged || socketChanged) {
        const epoch = randomUUID();
        this.namespaceOwners.set(namespace, {
          sessionId: winner.sessionId,
          socket: winner.session.socket,
          epoch,
        });

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

const invokedAsBroker = process.argv.some((argument) => {
  const normalized = argument.replaceAll("\\", "/");
  return normalized === "broker.ts" || normalized.endsWith("/broker.ts");
});
if (invokedAsBroker) {
  new IntercomBroker().start();
}
