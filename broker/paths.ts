import { chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const INTERCOM_DIR_MODE = 0o700;
export const INTERCOM_RUNTIME_FILE_MODE = 0o600;

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getIntercomDirPath(homeDir: string = homedir()): string {
  return join(homeDir, ".pi/agent/intercom");
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  return join(getIntercomDirPath(homeDir), "broker.sock");
}

export function ensureIntercomRuntimeDir(
  intercomDir: string = getIntercomDirPath(),
  platform: NodeJS.Platform = process.platform,
): void {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}

export function restrictIntercomRuntimeFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}
