import { readFileSync } from "node:fs";
import { getBrokerConnectTarget, type BrokerConnectTarget } from "./paths.ts";
import { probeBrokerEndpoint } from "./spawn.ts";

export async function assertNoLiveBroker(
  pidPath: string,
  resolveTarget: () => BrokerConnectTarget = getBrokerConnectTarget,
): Promise<void> {
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

  let target: BrokerConnectTarget;
  try {
    target = resolveTarget();
  } catch {
    // No readable endpoint record means the recorded process never became a broker we can reach.
    return;
  }
  // A live PID alone may be reused by an unrelated process; only the endpoint shows a broker.
  // One that holds the endpoint without answering is treated as a wedged broker and left alone.
  if (await probeBrokerEndpoint(target) === "absent") return;
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
