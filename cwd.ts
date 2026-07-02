import { resolve } from "node:path";
import { realpathSync } from "node:fs";

// Normalize a cwd for same-directory comparison. A raw string match ("a === b")
// hides genuine same-directory peers when two cwd strings differ only by a
// trailing slash, a "."/".." segment, or a symlink (e.g. macOS /tmp <->
// /private/tmp). resolve() collapses the lexical variants; realpathSync()
// collapses symlinks (best-effort: falls back to the resolved path if the
// directory no longer exists). Memoized — the set of distinct cwd strings is
// small and stable, so repeat comparisons are free after warmup.
const normalizeCache = new Map<string, string>();

export function normalizeCwd(cwd: string): string {
  const cached = normalizeCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolve(cwd);
  let normalized: string;
  try {
    normalized = realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  normalizeCache.set(cwd, normalized);
  return normalized;
}

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b);
}
