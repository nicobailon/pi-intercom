import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message, Attachment } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";

const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
const INTERCOM_DETACH_TIMEOUT_MS = 200;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  return {
    name: resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}
export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  const replyTracker = new ReplyTracker();
  const pendingInterruptedMessages: Array<{
    from: SessionInfo;
    message: Message;
    replyCommand?: string;
    bodyText: string;
  }> = [];
  const pendingDeferredMessages: Array<{
    from: SessionInfo;
    message: Message;
    replyCommand?: string;
    bodyText: string;
  }> = [];
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function buildRegistration(): Omit<SessionInfo, "id"> {
    if (!runtimeContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    return {
      name: identity.name,
      cwd: runtimeContext.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: config.status,
    };
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client) {
      return;
    }
    client.updatePresence(buildPresenceIdentity(pi, sessionId));
  }
  function sendIncomingMessage(entry: {
    from: SessionInfo;
    message: Message;
    replyCommand?: string;
    bodyText: string;
  }, delivery: "trigger" | "followUp" | "followUpTrigger"): void {
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger"
        ? { triggerTurn: true }
        : delivery === "followUpTrigger"
          ? { triggerTurn: true, deliverAs: "followUp" }
          : { deliverAs: "followUp" }
    );
  }
  function flushInterruptedMessages(): void {
    if (pendingInterruptedMessages.length === 0) {
      return;
    }
    const entries = pendingInterruptedMessages.splice(0, pendingInterruptedMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }
  function flushDeferredMessages(): void {
    if (pendingDeferredMessages.length === 0) {
      return;
    }
    const entries = pendingDeferredMessages.splice(0, pendingDeferredMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "followUpTrigger" : "followUp");
    });
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return;
      }
    }
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      if (!ctx.isIdle()) {
        const detached = await requestGracefulDetach();
        if (detached) {
          sendIncomingMessage(entry, "trigger");
          return;
        }
        if (!ctx.isIdle()) {
          if (message.replyTo) {
            pendingDeferredMessages.push(entry);
            return;
          }
          pendingInterruptedMessages.push(entry);
          ctx.abort();
          return;
        }
      }
      sendIncomingMessage(entry, "trigger");
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      if (client !== nextClient || !runtimeContext) {
        return;
      }
      handleIncomingMessage(runtimeContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (shuttingDown || reconnectTimer || reconnectPromise || !runtimeContext) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    if (!runtimeContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise) {
      return reconnectPromise;
    }
    reconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded();
        await nextClient.connect(buildRegistration());
        if (shuttingDown) {
          await nextClient.disconnect();
          throw new Error("Intercom shutting down");
        }
        client = nextClient;
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background") {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        reconnectPromise = null;
      }
    })();
    return reconnectPromise;
  }
  async function requestGracefulDetach(): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, INTERCOM_DETACH_TIMEOUT_MS);
      const unsubscribe = pi.events.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
        if (!payload || typeof payload !== "object") {
          return;
        }
        const response = payload as { requestId?: unknown; accepted?: unknown };
        if (response.requestId !== requestId) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve(response.accepted === true);
      });
      pi.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId });
    });
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return byId.id;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
    }
    return byName[0]?.id ?? null;
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    shuttingDown = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    try {
      await ensureConnected("startup");
    } catch {
      client = null;
      // Startup failures are retried in the background. Avoid raw logging here because it corrupts the Pi TUI.
      scheduleReconnect();
    }
  });
  
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearReconnectTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    pendingInterruptedMessages.length = 0;
    pendingDeferredMessages.length = 0;
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", () => {
    replyTracker.endTurn();
    setTimeout(() => {
      flushInterruptedMessages();
    }, 0);
  });
  pi.on("agent_end", () => {
    setTimeout(() => {
      flushDeferredMessages();
    }, 0);
  });
  pi.on("turn_start", (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    syncPresenceIdentity(ctx.sessionManager.getSessionId());
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
      });
    }
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
              };
            }

            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
            };
          }
          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
              };
            }
            if (!replyTo && config.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
            };
          }
          let replyPromise: Promise<Message> | null = null;

          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
              };
            }
            const questionId = randomUUID();
            replyPromise = waitForReply(sendTo, questionId, _signal);
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              isError: true,
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            replyTracker.markReplied(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              isError: true,
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
    },
  });

  async function openIntercomOverlay(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> {
    if (!ctx.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      ctx.ui.notify(`Intercom unavailable: ${getErrorMessage(error)}`, "error");
      return;
    }

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        ctx.ui.notify("Current session is missing from intercom session list", "error");
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      ctx.ui.notify(`Failed to list sessions: ${getErrorMessage(error)}`, "error");
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => {
        return new SessionListOverlay(theme, keybindings, currentSession, sessions, done);
      },
      { overlay: true }
    );

    if (!selectedSession) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      ctx.ui.notify(`Intercom unavailable: ${getErrorMessage(error)}`, "error");
      return;
    }

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => {
        return new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done);
      },
      { overlay: true }
    );

    if (result.sent && result.messageId && result.text) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      ctx.ui.notify(`Message sent to ${targetLabel}`, "info");
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
