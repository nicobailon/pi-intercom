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

  let target: BrokerConnectTarget;
  try {
    target = resolveTarget();
  } catch {
    // No readable endpoint record means the recorded process never became a broker we can reach.
    return;
  }
  // The recorded PID cannot show a broker: it may be reused by an unrelated process or
  // belong to another pid namespace, so only the endpoint decides.
  // One that holds the endpoint without answering is treated as a wedged broker and left alone.
  if (await probeBrokerEndpoint(target) === "absent") return;
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
