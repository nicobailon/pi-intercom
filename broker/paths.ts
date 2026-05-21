import { join } from "path";
import { homedir } from "os";
import { writeFileSync, readFileSync, existsSync } from "fs";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const PORT_FILE = join(INTERCOM_DIR, "broker.port");

/**
 * Check if TCP mode is forced via env var or config.
 */
function shouldUseTcp(platform: NodeJS.Platform = process.platform): boolean {
  // Force TCP if env var is set
  if (process.env.PI_INTERCOM_TCP === "1") return true;
  // Force TCP on Windows if named pipes are blocked
  if (platform === "win32") return true;
  return false;
}

/**
 * Get the TCP port for the broker.
 * Reads from port file if exists, otherwise uses a fixed port.
 */
function getTcpPort(): number {
  const FIXED_PORT = 19315;
  try {
    if (existsSync(PORT_FILE)) {
      const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
      if (Number.isFinite(port) && port > 0 && port < 65536) return port;
    }
  } catch {}
  return FIXED_PORT;
}

/**
 * Write the TCP port to the port file so clients can discover it.
 */
export function writeBrokerPort(port: number): void {
  writeFileSync(PORT_FILE, String(port), "utf-8");
}

/**
 * Read the broker TCP port from the port file.
 */
export function readBrokerPort(): number {
  return getTcpPort();
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (shouldUseTcp(platform)) {
    return String(getTcpPort());
  }

  // Original Unix named pipe / Windows named pipe logic
  if (platform === "win32") {
    function sanitizePipeSegment(value: string): string {
      return value
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "default";
    }
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  return join(homeDir, ".pi/agent/intercom/broker.sock");
}

/**
 * Check if the socket path is a TCP port (numeric string).
 */
export function isTcpMode(socketPath: string): boolean {
  return /^\d+$/.test(socketPath);
}

/**
 * Get the TCP port from a socket path that is a numeric string.
 */
export function parseTcpPort(socketPath: string): number {
  return parseInt(socketPath, 10);
}