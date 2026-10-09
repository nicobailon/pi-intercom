// One wake prompt per idle session, shared by every extension that wakes Pi with sendUserMessage
// (pi-intercom and pi-subagents). Pi marks a run active only after the prompt's async preflight, so
// a second wake sent in that gap throws "Agent is already processing a prompt" from agent.prompt().
// The key and the { sessionId, sentAt } shape are the cross-extension contract; change them in both.
type WakeReservation = { sessionId: string; sentAt?: number };
type SessionRef = { getSessionId(): string };

const WAKE_PENDING_MS = 10_000;
const reservationsKey = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsKey]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsKey] ?? (wakeGlobal[reservationsKey] = new WeakMap<object, WakeReservation>());

function reservationFor(sessionManager: SessionRef): WakeReservation {
  const sessionId = sessionManager.getSessionId();
  const current = reservations.get(sessionManager);
  if (current?.sessionId === sessionId) return current;
  const next = { sessionId };
  reservations.set(sessionManager, next);
  return next;
}

// Pi emits no agent_start for a handled or failed preflight, so a reservation expires instead of latching.
export function isIdleWakePending(sessionManager: SessionRef): boolean {
  const { sentAt } = reservationFor(sessionManager);
  return sentAt !== undefined && Date.now() - sentAt < WAKE_PENDING_MS;
}

export function reserveIdleWake(sessionManager: SessionRef): void {
  reservationFor(sessionManager).sentAt = Date.now();
}

export function releaseIdleWake(sessionManager: SessionRef): void {
  reservationFor(sessionManager).sentAt = undefined;
}
