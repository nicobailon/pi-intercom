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

  let pidAlive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // The broker runs as the same user as its clients, so EPERM means the
    // recorded pid now belongs to another user's process (pid reuse after a reboot).
    // ESRCH and EPERM also come from a pid written in another pid namespace, so the
    // endpoint still decides whether a broker is running.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    pidAlive = false;
  }

  let target: BrokerConnectTarget;
  try {
    target = resolveTarget();
  } catch {
    // No readable endpoint record means the recorded process never became a broker we can reach.
    return;
  }
  // A PID alone may be reused by an unrelated process or belong to another namespace;
  // only the endpoint shows a broker.
  // One that holds the endpoint without answering is treated as a wedged broker and left alone.
  if (await probeBrokerEndpoint(target) === "absent") return;
  throw new Error(pidAlive
    ? `Refusing to replace live intercom broker process ${pid}`
    : `Refusing to replace an intercom broker that still holds its endpoint; broker.pid names process ${pid}, which this process cannot see`);
}
