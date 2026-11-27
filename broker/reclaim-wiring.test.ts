/**
 * The reclaim deadline must not leave a stale timestamp behind.
 *
 * `shouldReclaimWhileBlocked` is covered by pure tests. What those cannot see is
 * whether the *caller* keeps its bookkeeping consistent: `index.ts` clears
 * `sessionHeldBlocked` in three places, and each of them must also clear
 * `sessionHeldSinceMs`.
 *
 * If one does not, the next block starts with a timestamp already in the past,
 * the 60 s budget is satisfied immediately, and the reclaim fires on every tick
 * — a self-inflicted reconnect storm. That failure is invisible to the pure
 * tests and to `intercom status`.
 *
 * This is a structural test: it reads index.ts and asserts the invariant
 * "every write of `sessionHeldBlocked = false` is followed by clearing the
 * timestamp". It is slower to read than a unit test and it is the only way to
 * cover a caller we cannot import (index.ts is a live extension whose peer
 * dependencies come from the harness).
 *
 * If this test fails, the fix is not to relax it: find the site that clears the
 * flag without clearing the timestamp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** Indices of every `sessionHeldBlocked = false` assignment, excluding the declaration. */
function clearSites(): number[] {
  const sites: number[] = [];
  const pattern = /sessionHeldBlocked\s*=\s*false/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // The declaration reads `let sessionHeldBlocked = false;` and is not a
    // clear: there is no timestamp to clear yet.
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineHead = source.slice(lineStart, match.index);
    if (/\blet\s+$/.test(lineHead)) continue;
    sites.push(match.index);
  }
  return sites;
}

test("index.ts clears sessionHeldBlocked somewhere", () => {
  assert.ok(clearSites().length >= 2, "expected at least the reclaim and the connect path");
});

test("every place that clears the flag also clears the timestamp", () => {
  const sites = clearSites();
  const window = 400; // enough for the assignment plus its immediate block
  const offenders: string[] = [];

  for (const at of sites) {
    const after = source.slice(at, at + window);
    if (!/sessionHeldSinceMs\s*=\s*null/.test(after)) {
      const line = source.slice(0, at).split("\n").length;
      offenders.push(`index.ts:${line} clears sessionHeldBlocked without sessionHeldSinceMs`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a stale timestamp makes the next block reclaim immediately, causing a reconnect storm",
  );
});

test("the reclaim path consults the budget rather than retrying unconditionally", () => {
  // The defect was that the flag blocked reconnection with no way out. The fix
  // must gate on the budget, not simply drop the flag.
  assert.match(
    source,
    /shouldReclaimWhileBlocked\s*\(/,
    "the reclaim path must ask the budget function",
  );
  assert.match(
    source,
    /sessionHeldSinceMs\s*=\s*Date\.now\(\)/,
    "the block must record when it started",
  );
});
