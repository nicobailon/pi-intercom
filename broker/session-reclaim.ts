/**
 * When a blocked session may reclaim itself without external traffic.
 *
 * `sessionHeldBlocked` (index.ts:750) stops `scheduleReconnect` (:1642) and is
 * cleared only after a successful connect (:1702) or at :2140. A session
 * blocked because a stale process held its id therefore never reconnects:
 * there is no traffic, so there is no successful connect, so the flag never
 * clears. Field report 2026-11-27: two agents vanished from the channel after a
 * broker restart and came back only when someone messaged them.
 *
 * The fix is a wall-clock budget: after that long with no successful connect,
 * force one reclaim attempt. The budget is derived from the client's own
 * reconnect backoff rather than invented, so the reclaim never fires *between*
 * backoff steps and adds no extra load.
 */

/**
 * The client's reconnect backoff ramp, from index.ts:939.
 *
 * Duplicated here deliberately, and asserted by the tests: if the ramp changes
 * upstream, this budget must be revisited rather than silently drifting below
 * or above it.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Ceiling of the backoff ramp: one full ramp before forcing a reclaim. */
export function reclaimBudgetMs(): number {
  const ceiling = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] ?? 30_000;
  // One full ramp plus a margin, so the reclaim lands after the ramp has had
  // its chance and never competes with a scheduled attempt.
  return ceiling * 2;
}

/**
 * Whether a blocked session should force a reclaim attempt now.
 *
 * - `blockedSinceMs === null` means the session is not blocked: the normal
 *   reconnect path owns it, and this must stay silent.
 * - Otherwise the reclaim fires once each time `blockedSinceMs` is at least
 *   `budgetMs` in the past. The caller advances `blockedSinceMs` after firing,
 *   which is what makes it fire once per budget rather than on every tick.
 */
export function shouldReclaimWhileBlocked(args: {
  blockedSinceMs: number | null;
  nowMs: number;
  budgetMs?: number;
}): boolean {
  const { blockedSinceMs, nowMs } = args;
  if (blockedSinceMs === null) return false;

  const budget = args.budgetMs ?? reclaimBudgetMs();
  if (budget <= 0) return false;

  return nowMs - blockedSinceMs >= budget;
}
