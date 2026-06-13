import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import { resolveAskTimeoutMs } from "../config.js";
import type { SessionInfo, Message, Attachment, BrokerMessage } from "../types.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
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
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  // Outstanding ask edges: askerId -> { to, questionId, at }. A session has at
  // most one outstanding ask (the extension enforces a single reply waiter), so
  // a single entry per asker suffices. Used to refuse a mutual "ask" before it
  // blocks: if A asks B while B is already awaiting A's reply, A's ask is
  // rejected immediately instead of both turns stalling until the reply
  // timeout. Whichever ask the broker dequeues first wins (FIFO).
  private askEdges = new Map<string, { to: string; questionId: string; at: number }>();
  private readonly askTimeoutMs = resolveAskTimeoutMs();

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
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
      writeFileSync(PID_PATH, String(process.pid));
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
        this.sessions.delete(sessionId);
        this.clearAskEdgesFor(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);

        this.scheduleShutdownCheck();
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
        
        const id = randomUUID();
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
        this.sessions.delete(currentId);
        this.clearAskEdgesFor(currentId);
        this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
        setId(null);
        this.scheduleShutdownCheck();
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

        const targets = this.findSessions(clientMessage.to);
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }

          const recipientId = targets[0].info.id;
          const now = Date.now();
          this.pruneAskEdges(now);
          if (message.expectsReply === true) {
            // Mutual-ask deadlock guard: if the recipient is already awaiting a
            // reply from this sender, a reverse ask would block both turns until
            // the reply timeout. Refuse it immediately so the caller fails fast.
            const reverse = this.askEdges.get(recipientId);
            if (reverse && reverse.to === currentId) {
              writeMessage(socket, {
                type: "delivery_failed",
                messageId: message.id,
                reason: `Mutual ask refused: "${targets[0].info.name ?? recipientId}" is already awaiting a reply from you. Use send/reply instead of ask, or wait for the pending ask to resolve.`,
              });
              break;
            }
            this.askEdges.set(currentId, { to: recipientId, questionId: message.id, at: now });
          } else if (typeof message.replyTo === "string") {
            // A reply clears the asker's edge. The reply flows answerer -> asker,
            // so the asker is this message's recipient; match the question id.
            const askerEdge = this.askEdges.get(recipientId);
            if (askerEdge && askerEdge.questionId === message.replyTo) {
              this.askEdges.delete(recipientId);
            }
          }

          writeMessage(targets[0].socket, {
            type: "message",
            from: fromSession.info,
            message,
          });
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

      case "presence": {
        const session = this.sessions.get(currentId);
        if (session) {
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

  // Drop ask edges older than the configured reply timeout, matching the
  // extension's waitForReply timeout so a timed-out ask leaves no phantom edge.
  private pruneAskEdges(now: number): void {
    for (const [asker, edge] of this.askEdges) {
      if (now - edge.at > this.askTimeoutMs) {
        this.askEdges.delete(asker);
      }
    }
  }

  // On disconnect, drop this session's own outstanding ask and any ask awaiting
  // a reply from it, so a peer can re-ask without falsely tripping the guard.
  private clearAskEdgesFor(id: string): void {
    this.askEdges.delete(id);
    for (const [asker, edge] of this.askEdges) {
      if (edge.to === id) {
        this.askEdges.delete(asker);
      }
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    return Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
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
