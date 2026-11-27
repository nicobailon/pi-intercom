/**
 * Process identity by start time, not by existence.
 *
 * `process.kill(pid, 0)` answers "does *some* process have this number". Linux
 * reassigns PIDs, so that answer can be true for a process that has nothing to
 * do with the one we recorded. Field report 2026-11-27: a dead session's PID
 * was reused, the broker read it as "still alive", and every message to that
 * session failed for twenty minutes with
 * `Intercom session <id> is held by live process <pid>`.
 *
 * Field 22 of `/proc/PID/stat` is the process start time in clock ticks. It is
 * stable for the lifetime of a process and different for any process that
 * reuses the number, which makes it the cheapest reliable discriminator on
 * Linux without pidfd.
 *
 * Field 3 is the process state. Zombies (`Z`) have already exited and only wait
 * to be reaped; `kill(pid, 0)` succeeds on them, so an existence check reports
 * a zombie as alive — the second way the old check lied.
 */
import { readFileSync } from "node:fs";

export type ProcessIdentity = {
  /** Start time in clock ticks since boot, field 22 of /proc/PID/stat. */
  start: string;
  /** One-letter process state, field 3 of /proc/PID/stat. */
  state: string;
};

/** States that mean the process cannot hold anything: zombie, dead, or gone. */
const NOT_ALIVE = new Set(["Z", "X", "x"]);

/**
 * Identity of a running process, or undefined if it cannot be read.
 *
 * Returns undefined rather than throwing: "no such process" and "not ours to
 * inspect" both mean we have no identity to compare, and callers treat that the
 * same way.
 */
export function processIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;

  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }

  // The second field is the executable name in parentheses and may contain
  // spaces or parentheses, so split only after the LAST ')'. Indices below are
  // relative to that remainder: [0] = state, [19] = start time.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const state = rest[0];
  const start = rest[19];
  if (typeof state !== "string" || !/^[A-Za-z]$/.test(state)) return undefined;
  if (typeof start !== "string" || !/^[0-9]+$/.test(start)) return undefined;

  return { start, state };
}

/**
 * Whether the recorded identity still belongs to the process at `pid`.
 *
 * `recordedStart` is what was captured when the session was registered. A
 * mismatch means the number was reused, so the recorded owner is gone.
 */
export function sameProcess(
  identity: ProcessIdentity | undefined,
  pid: number,
  recordedStart: string,
): boolean {
  if (!identity) return false;
  if (NOT_ALIVE.has(identity.state)) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return identity.start === recordedStart;
}

/**
 * Whether a PID is alive *and* is still the process we recorded.
 *
 * Drop-in replacement for the old existence-only probe. When no recorded start
 * is available the caller must decide explicitly: passing `undefined` here
 * returns false, because an identity we cannot compare cannot be trusted to
 * hold a session.
 */
export function isRecordedProcessAlive(
  pid: number,
  recordedStart: string | undefined,
): boolean {
  if (recordedStart === undefined) return false;
  return sameProcess(processIdentity(pid), pid, recordedStart);
}
