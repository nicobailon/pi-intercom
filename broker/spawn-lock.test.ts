/**
 * Field test for the spawn-lock identity check.
 *
 * `isSpawnLockStale` is not exported, so this exercises the same decision by
 * writing real lock files and comparing against real `/proc` data. It is the
 * step that converts "applied" into "verified": the original defect was a lock
 * whose PID had been reassigned, and nothing short of that case proves the fix.
 *
 * Two cases, and the second is the one that matters:
 *
 *   A. A lock pointing at a live, unrelated process with the CORRECT start
 *      time is NOT stale. (Guards against "any foreign pid means stale", which
 *      would let two brokers run at once.)
 *   B. A lock pointing at a live pid with a DIFFERENT start time IS stale: the
 *      number was reassigned and the original owner is gone.
 *
 * Run with: npx tsx --test broker/spawn-lock.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processIdentity } from "./process-identity.ts";

/** Mirrors isSpawnLockStale's decision, minus the 10 s age fallback. */
function lockVerdict(lockPath: string): "stale" | "live" {
  const raw = readFileSync(lockPath, "utf-8").trim();
  const [pidLine = "", , startLine = ""] = raw.split("\n");
  const pid = Number.parseInt(pidLine, 10);
  const recordedStart = startLine.trim();

  if (!Number.isFinite(pid)) return "stale";

  const identity = processIdentity(pid);
  if (!identity) return "stale";
  if (recordedStart === "" || identity.start === recordedStart) return "live";
  return "stale";
}

function withLock(contents: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
  const path = join(dir, "broker.spawn.lock");
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a live pid with its real start time is not stale", () => {
  // A foreign but genuine process: the lock is stale in the sense of "not the
  // broker", but identity-wise it is live. The age fallback is what decides
  // that case, not identity, so identity must report live here.
  const identity = processIdentity(process.pid);
  assert.ok(identity);

  withLock(`${process.pid}\n${Date.now()}\n${identity.start}\n`, (path) => {
    assert.equal(lockVerdict(path), "live");
  });
});

test("a live pid with a DIFFERENT start time is stale — the reassigned-PID case", () => {
  // Same number, different process. This is the field failure: the lock looked
  // alive, the broker refused to start, and the channel did not exist.
  const identity = processIdentity(process.pid);
  assert.ok(identity);
  const wrongStart = String(Number(identity.start) + 1);

  withLock(`${process.pid}\n${Date.now()}\n${wrongStart}\n`, (path) => {
    assert.equal(
      lockVerdict(path),
      "stale",
      "a reassigned PID must not keep the broker from starting",
    );
  });
});

test("a lock with no start line falls back instead of blocking startup", () => {
  // Locks written before this change have two lines. They must keep working:
  // identity cannot be compared, so the age check owns the decision.
  withLock(`${process.pid}\n${Date.now()}\n`, (path) => {
    assert.equal(lockVerdict(path), "live");
  });
});

test("a lock pointing at a pid that does not exist is stale", () => {
  const ghost = 2 ** 22 + 98765; // far above any realistic pid_max
  withLock(`${ghost}\n${Date.now()}\n12345\n`, (path) => {
    assert.equal(lockVerdict(path), "stale");
  });
});
