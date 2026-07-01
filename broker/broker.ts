import net from "net";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getBrokerSocketPath,
  getIntercomDirPath,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
} from "./paths.ts";
import { getAskTimeoutMs } from "../config.ts";
import type { SessionInfo, Message, Attachment, BrokerMessage } from "../types.ts";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface AskEdge {
  from: string;
  to: string;
  createdAt: number;
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

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
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

  return session.status === undefined || typeof session.status === "string";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private askEdges = new Map<string, AskEdge>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly askTimeoutMs = getAskTimeoutMs();

  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      restrictIntercomRuntimeFile(SOCKET_PATH);
      writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing?.socket === socket) {
          this.sessions.delete(sessionId);
          this.clearAskEdgesForSession(sessionId);
          this.broadcast({ type: "session_left", sessionId }, sessionId);
          this.scheduleShutdownCheck();
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
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
        const previous = this.sessions.get(id);
        if (previous) {
          this.clearAskEdgesForSession(id);
          previous.socket.end();
        }
        setId(id);
        const info: SessionInfo = { ...clientMessage.session, id };
        this.sessions.set(id, { socket, info });
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        if (!currentId) {
          throw new Error("Received unregister before register");
        }
        const existing = this.sessions.get(currentId);
        if (existing?.socket === socket) {
          this.sessions.delete(currentId);
          this.clearAskEdgesForSession(currentId);
          this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
          this.scheduleShutdownCheck();
        }
        setId(null);
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

        this.pruneAskEdges();
        const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;

        const targets = this.findSessions(clientMessage.to);
        if (targets.length === 1) {
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
          writeMessage(target.socket, {
            type: "message",
            from: fromSession.info,
            message,
          });
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
          }
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

        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Session not found",
        });
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
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            session.info.name = clientMessage.name;
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            session.info.model = clientMessage.model;
          }
          session.info.lastActivity = Date.now();
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
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

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
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
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
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
