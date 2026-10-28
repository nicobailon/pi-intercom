import { existsSync, readFileSync } from "node:fs";

export function assertNoLiveBroker(pidPath: string): void {
  if (!existsSync(pidPath)) return;

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, 0);
  } catch (error) {
    // The broker runs as the same user as its clients, so EPERM means the
    // recorded pid now belongs to another user's process (pid reuse after a reboot).
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return;
    throw error;
  }
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
