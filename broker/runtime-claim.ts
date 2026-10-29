import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerConnectTarget, type BrokerConnectTarget } from "./paths.ts";
import { isBrokerHealthOkMessage } from "./spawn.ts";

const PROBE_TIMEOUT_MS = 1000;

type EndpointState = "broker" | "absent" | "unresponsive";

// A bare PID cannot say whether the process is still our broker: after a reboot the OS may
// hand the recorded PID to an unrelated process. Only the broker's own endpoint can.
function probeBrokerEndpoint(target: BrokerConnectTarget): Promise<EndpointState> {
  return new Promise((resolve) => {
    const socket = typeof target === "string"
      ? net.connect(target)
      : net.connect({ host: target.host, port: target.port });
    const requestId = randomUUID();
    const finish = (state: EndpointState) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(state);
    };
    const reader = createMessageReader(
      (message) => finish(isBrokerHealthOkMessage(message, requestId) ? "broker" : "absent"),
      () => finish("absent"),
    );
    socket.on("connect", () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...(typeof target === "string" || !target.stateId ? {} : { stateId: target.stateId }),
        });
      } catch {
        finish("absent");
      }
    });
    socket.on("data", reader);
    // Nothing listening means no broker. Any other failure leaves it unknown.
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" || code === "ECONNREFUSED" ? "absent" : "unresponsive");
    });
    // Closing without a health reply means whatever owns the endpoint is not a broker.
    socket.on("close", () => finish("absent"));
    const timeout = setTimeout(() => finish("unresponsive"), PROBE_TIMEOUT_MS);
  });
}

export async function assertNoLiveBroker(
  pidPath: string,
  resolveTarget: () => BrokerConnectTarget = getBrokerConnectTarget,
): Promise<void> {
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

  let target: BrokerConnectTarget;
  try {
    target = resolveTarget();
  } catch {
    // No readable endpoint record means the recorded process never became a broker we can reach.
    return;
  }
  // A process that holds the PID but not the endpoint is not the broker. One that holds the
  // endpoint without answering is treated as a wedged broker and left alone.
  if (await probeBrokerEndpoint(target) === "absent") return;
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
