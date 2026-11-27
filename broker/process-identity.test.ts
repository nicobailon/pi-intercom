/**
 * A reused PID is not a live session owner.
 *
 * Field report, 2026-11-27: a stale idle `pi` process (pid 7178, 16 hours old)
 * died, the kernel reassigned its PID to an unrelated process, and the broker
 * kept refusing every message with
 *
 *     Intercom session <id> is held by live process 7178
 *
 * for twenty minutes. Four agents received nothing. The process resisted
 * SIGTERM and needed SIGKILL.
 *
 * `process.kill(pid, 0)` answers "does *some* process have this number", which
 * is not the question. The question is "is it *the same* process". Linux gives
 * every process a start time (field 22 of /proc/PID/stat) that is stable for
 * its lifetime and different for anything that reuses the number.
 *
 * These tests exercise the identity primitive directly, because reproducing a
 * PID reuse needs a spawn loop and is not deterministic in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { processIdentity, sameProcess } from "./process-identity.ts";

test("a live process reports a stable identity across calls", () => {
  const first = processIdentity(process.pid);
  const second = processIdentity(process.pid);

  assert.ok(first, "the current process must have an identity");
  assert.ok(second);
  assert.equal(first.start, second.start, "start ticks must not drift");
});

test("sameProcess accepts the same pid with the same start ticks", () => {
  const identity = processIdentity(process.pid);
  assert.ok(identity);

  assert.equal(sameProcess(identity, process.pid, identity.start), true);
});

test("sameProcess rejects a pid whose start ticks differ — the reused-PID case", () => {
  const identity = processIdentity(process.pid);
  assert.ok(identity);

  // Same number, different process: exactly what the kernel does after a death.
  const reassigned = String(Number(identity.start) + 1);
  assert.equal(
    sameProcess(identity, process.pid, reassigned),
    false,
    "a different start time means a different process, and must not be treated as the owner",
  );
});

test("sameProcess rejects a pid that does not exist", () => {
  // PID 0 is never a user process; the call must not throw.
  assert.equal(sameProcess(undefined, 0, "1"), false);
});

test("a zombie is not a live owner", () => {
  // Zombies (Z) have exited and only wait to be reaped: they cannot hold a
  // session. `kill(pid, 0)` succeeds on them, which is a second way the old
  // check lied.
  const identity = { start: "12345", state: "Z" };

  assert.equal(sameProcess(identity, 1, "12345"), false);
});

test("processIdentity returns undefined for a pid that cannot be read", () => {
  // No such process, or no permission: both mean "no identity", never a throw.
  const missing = processIdentity(2 ** 22 + 12345);

  assert.equal(missing, undefined);
});
