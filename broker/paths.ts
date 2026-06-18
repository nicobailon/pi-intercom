import { join } from "path";
import { homedir } from "os";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

function expandAgentDir(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/**
 * Resolve the Pi agent directory. Honors PI_CODING_AGENT_DIR (with `~` / `~/`
 * expansion) to stay consistent with pi-subagents' getAgentDir, so a relocated
 * agent dir keeps the intercom broker socket, pid, and config co-located with
 * the rest of Pi's writable state. Falls back to `~/.pi/agent`.
 */
export function getAgentDir(homeDir: string = homedir()): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return expandAgentDir(configured, homeDir);
  return join(homeDir, ".pi", "agent");
}

/** Resolve the intercom state directory (broker socket/pid/config) under the agent dir. */
export function getIntercomDir(homeDir: string = homedir()): string {
  return join(getAgentDir(homeDir), "intercom");
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  return join(getIntercomDir(homeDir), "broker.sock");
}
