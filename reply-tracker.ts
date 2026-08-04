import { getAskTimeoutMs } from "./config.ts";
import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  if (context.from.id === to || context.from.id.startsWith(to)) {
    return true;
  }

  return context.from.name?.toLowerCase() === to.toLowerCase();
}

function resolvePendingSender(pending: IntercomContext[], to: string): IntercomContext {
  const exactIdMatches = pending.filter((context) => context.from.id === to);
  if (exactIdMatches.length === 1) {
    return exactIdMatches[0]!;
  }
  if (exactIdMatches.length > 1) {
    throw new Error(`Multiple pending asks from session ID "${to}" — specify \`replyTo\``);
  }

  const lowerTo = to.toLowerCase();
  const exactNameMatches = pending.filter((context) => context.from.name?.toLowerCase() === lowerTo);
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0]!;
  }
  if (exactNameMatches.length > 1) {
    throw new Error(`Multiple pending asks match sender name "${to}" — specify a full session ID or \`replyTo\``);
  }

  const idPrefixMatches = pending.filter((context) => context.from.id.startsWith(to));
  if (idPrefixMatches.length === 1) {
    return idPrefixMatches[0]!;
  }
  if (idPrefixMatches.length > 1) {
    throw new Error(`Multiple pending asks match ID prefix "${to}" — use a longer session ID prefix or specify \`replyTo\``);
  }

  throw new Error(`No pending ask from "${to}"`);
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = getAskTimeoutMs()) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string; replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (options.replyTo) {
      const target = this.pendingAsks.get(options.replyTo);
      if (!target) {
        throw new Error(`No pending ask with message ID "${options.replyTo}"`);
      }
      if (options.to && !matchesPendingSender(target, options.to)) {
        throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
      }
      return target;
    }

    const pending = Array.from(this.pendingAsks.values());
    if (options.to) {
      return resolvePendingSender(pending, options.to);
    }

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    if (pending.length === 1) {
      return pending[0]!;
    }
    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  findUniquePendingAskFrom(to: string, now = Date.now()): IntercomContext | null {
    const candidates = Array.from(this.pendingAsks.values()).filter((context) => {
      if (now - context.receivedAt > this.askTimeoutMs) {
        return false;
      }
      return matchesPendingSender(context, to);
    });
    return candidates.length === 1 ? candidates[0]! : null;
  }

  markReplied(replyTo: string): void {
    this.dismissPendingAsk(replyTo);
  }

  dismissPendingAsk(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnContexts[index]?.message.id === replyTo) {
        this.pendingTurnContexts.splice(index, 1);
      }
    }
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.dismissPendingAsk(messageId);
      }
    }
  }
}
