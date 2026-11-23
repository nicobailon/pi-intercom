import type { SessionInfo } from "./types.ts";

// Compact token count for display: 1432 -> "1.4k", 144000 -> "144k". Keeps list
// rows short while staying legible.
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(Math.max(0, Math.round(tokens)));
  }
  const k = tokens / 1000;
  const value = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
  return `${value}k`;
}

// Render a session's context-window usage to sit beside its model, e.g.
// " · 72% ctx (144k/200k)". The token detail is appended only when both counts
// are known. Unknown percent (e.g. right after a compaction, before the next
// assistant response) renders nothing, so a frozen value is never shown as a
// stale percentage.
export function formatContextUsage(session: SessionInfo): string {
  if (typeof session.contextPct !== "number") {
    return "";
  }
  let out = ` · ${session.contextPct}% ctx`;
  if (
    typeof session.contextTokens === "number"
    && typeof session.contextWindow === "number"
    && session.contextWindow > 0
  ) {
    out += ` (${formatTokenCount(session.contextTokens)}/${formatTokenCount(session.contextWindow)})`;
  }
  return out;
}
