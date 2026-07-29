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
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
