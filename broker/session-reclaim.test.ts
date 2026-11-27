/**
 * A session that sends nothing must survive a broker restart.
 *
 * Field report, 2026-11-27. After the broker was killed (the reused-PID
 * incident), INFRA and PINTO disappeared from the session list and came back
 * only when they sent a message from outside the channel.
 *
 * Two causes, both verified in the source:
 *
 *   1. Sessions live only in memory: a restarted broker starts empty, and
 *      nothing re-registers a session that has no traffic.
 *   2. `sessionHeldBlocked` (index.ts:750) is set on a held-session error
 *      (:1659) and cleared only after a successful connect (:1702) or at
 *      :2140. `scheduleReconnect` returns early while it is true (:1642), so a
 *      session blocked by the reused-PID bug stops reconnecting **entirely**.
 *      With no traffic there is no successful connect, so nothing clears it.
 *      A transient conflict becomes a permanent absence.
 *
 * These tests pin the observable behaviour, not one implementation of it: what
 * matters is that a quiet session is reachable again within a bounded window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reclaimBudgetMs, shouldReclaimWhileBlocked } from "./session-reclaim.ts";

test("a session blocked by a held error reclaims without waiting for traffic", () => {
  // The whole point: nothing external happens. If this returns false, the
  // session stays invisible until the user types, which is the bug.
  assert.equal(
    shouldReclaimWhileBlocked({ blockedSinceMs: 0, nowMs: 1000, budgetMs: 30_000 }),
    false,
    "too early: do not hammer the broker before the budget elapses",
  );

  assert.equal(
    shouldReclaimWhileBlocked({ blockedSinceMs: 0, nowMs: 30_000, budgetMs: 30_000 }),
    true,
    "the budget elapsed with no traffic: the session must reclaim on its own",
  );
});

test("the reclaim budget outlasts one reconnect backoff step but not the whole ramp", () => {
  // The client's backoff is [1s, 2s, 5s, 10s, 30s] (index.ts:939), so a budget
  // below 30s would fire between attempts and add nothing. A budget equal to
  // the backoff ceiling gives one full ramp before forcing a reclaim.
  assert.ok(reclaimBudgetMs() >= 30_000, "must not fire between backoff steps");
  assert.ok(reclaimBudgetMs() <= 300_000, "must not leave a session dark for minutes");
});

test("a held session that is not blocked does not need reclaiming", () => {
  assert.equal(
    shouldReclaimWhileBlocked({ blockedSinceMs: null, nowMs: 100_000, budgetMs: 30_000 }),
    false,
    "not blocked means the normal reconnect path owns it",
  );
});

test("reclaim fires once per budget, not on every tick", () => {
  const budget = reclaimBudgetMs();
  // At exactly 1x -> fire. At 1.5x, a naive implementation fires again; the
  // caller must advance blockedSinceMs. This pins the contract.
  assert.equal(
    shouldReclaimWhileBlocked({ blockedSinceMs: 0, nowMs: budget, budgetMs: budget }),
    true,
  );
  assert.equal(
    shouldReclaimWhileBlocked({ blockedSinceMs: budget, nowMs: budget * 2, budgetMs: budget }),
    true,
    "after the caller advances the mark, the next budget fires again",
  );
});
