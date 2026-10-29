const FULL_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_IN_PATH = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const DISCOVERY_TIMEOUT_MS = 5_000;

export interface SavedMachine {
  label: string;
  target: string;
  enabled: boolean;
}

export interface RemoteAgent {
  name: string;
  sessionId?: string;
  cwd?: string;
  /** Herdr agent_status, e.g. "idle" or "working". */
  status?: string;
}

export interface DiscoveredRemoteAgent {
  machine: SavedMachine;
  agent: RemoteAgent;
  /** No saved Herdr machine matched, so the machine name is used directly as an SSH host. */
  viaSsh?: boolean;
}

export interface DiscoveryDeps {
  run: (command: string, args: string[], stdin?: string, timeoutMs?: number) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut?: boolean;
  }>;
  herdrBin: string;
  discoveryTimeoutMs?: number;
  /** Remote pi-intercom command that lists sessions on a machine reached directly over SSH. */
  remoteCommand?: string;
}

// A password or host-key prompt must fail instead of taking over Pi's terminal.
export const DIRECT_SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
// The agent supplies this host, so it must not start with "-" (ssh would read it as an option).
const SSH_HOST = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonOutput(raw: string, operation: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && "result" in parsed) return parsed.result;
    return parsed;
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }
}

export function parseSavedMachines(raw: string): SavedMachine[] {
  const value = parseJsonOutput(raw, "herdr machine list");
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.machines) ? value.machines : [];
  return rows.flatMap((row): SavedMachine[] => {
    if (!isRecord(row) || typeof row.label !== "string" || typeof row.target !== "string") return [];
    return [{ label: row.label, target: row.target, enabled: row.enabled !== false }];
  });
}

export function parseRemoteAgents(raw: string): RemoteAgent[] {
  const value = parseJsonOutput(raw, "herdr agent list");
  const rows = isRecord(value) && Array.isArray(value.agents) ? value.agents : [];
  return rows.flatMap((row): RemoteAgent[] => {
    if (!isRecord(row) || row.agent !== "pi") return [];
    const agentSession = isRecord(row.agent_session) ? row.agent_session : undefined;
    const sessionPath = agentSession?.kind === "path" && typeof agentSession.value === "string" ? agentSession.value : undefined;
    const sessionId = sessionPath?.match(SESSION_ID_IN_PATH)?.[1];
    // Herdr only reports a name for renamed panes; an unnamed Pi session is addressed by its session id.
    const name = typeof row.name === "string" && row.name ? row.name : sessionId;
    if (!name) return [];
    return [{
      name,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
      ...(typeof row.agent_status === "string" ? { status: row.agent_status } : {}),
    }];
  });
}

export function parseCrossMachineTarget(target: string): { agentTarget: string; machineLabel: string } {
  const parts = target.split("@");
  if (parts.length !== 2 || parts.some((part) => !part || /\s/.test(part))) {
    throw new Error(`Invalid remote target "${target}"; expected name@machine or full-session-uuid@machine.`);
  }
  return { agentTarget: parts[0], machineLabel: parts[1] };
}

export async function listSavedMachines(deps: DiscoveryDeps): Promise<SavedMachine[]> {
  const listed = await deps.run(deps.herdrBin, ["machine", "list", "--json"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (listed.code !== 0) throw new Error(`Could not list Herdr saved machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
  return parseSavedMachines(listed.stdout);
}

export async function listMachineAgents(machine: SavedMachine, deps: DiscoveryDeps): Promise<RemoteAgent[]> {
  const result = await deps.run(deps.herdrBin, ["--machine", machine.label, "agent", "list"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (result.code !== 0) {
    // Herdr prints Rust debug errors: Error: Custom { kind: …, error: "machine 'x': reason" }.
    const herdrError = result.stderr.match(/error: "((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1").replace(/^machine '[^']*': /, "");
    const detail = result.timedOut ? "timed out" : herdrError ?? (result.stderr.trim() || `exit ${result.code}`);
    const hint = /does not support machine API forwarding/.test(detail)
      ? ` Its running Herdr server is too old; update Herdr there, then run \`herdr --remote ${machine.target}\` in a terminal to replace the server.`
      : "";
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail.replace(/\.$/, "")}.${hint}`);
  }
  try {
    return parseRemoteAgents(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid response";
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail}`);
  }
}

async function listSshAgents(host: string, deps: DiscoveryDeps): Promise<RemoteAgent[]> {
  const remoteCommand = deps.remoteCommand ?? "pi-intercom";
  const result = await deps.run(
    "ssh",
    [...DIRECT_SSH_OPTIONS, host, `${remoteCommand} list --json`],
    undefined,
    deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
  );
  let listed: unknown;
  try {
    listed = JSON.parse(result.stdout);
  } catch {
    listed = undefined;
  }
  if (result.code === 0 && isRecord(listed) && listed.ok === true && Array.isArray(listed.sessions)) {
    return listed.sessions.flatMap((row: unknown): RemoteAgent[] => {
      // The listing CLI registers itself; CLI bridges are not Pi sessions.
      if (!isRecord(row) || typeof row.id !== "string" || row.model === "pi-intercom-cli") return [];
      return [{
        name: typeof row.name === "string" && row.name && row.name !== "(unnamed)" ? row.name : row.id,
        sessionId: row.id,
        ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
        ...(typeof row.status === "string" ? { status: row.status } : {}),
      }];
    });
  }
  if (isRecord(listed) && listed.ok === false && typeof listed.error === "string") {
    throw new Error(`pi-intercom on "${host}" could not list its sessions: ${listed.error.replace(/\s+/g, " ").trim()}`);
  }
  const detail = result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`;
  throw new Error(
    `Could not list intercom sessions on "${host}" over SSH: ${detail.replace(/\.$/, "")}. "${host}" is not a saved Herdr machine, so it is used as an SSH host.`
      + ` Check that \`ssh ${host}\` connects without a password or host-key prompt and that \`${remoteCommand} list\` works there;`
      + " if non-interactive SSH cannot find it, set crossMachine.remoteCommand to its absolute path.",
  );
}

function selectAgent(agents: RemoteAgent[], agentTarget: string, where: string): RemoteAgent {
  const bySessionId = FULL_SESSION_UUID.test(agentTarget);
  const matches = agents.filter((agent) => bySessionId
    ? agent.sessionId === agentTarget
    : agent.name.toLowerCase() === agentTarget.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`No live Pi agent on ${where} exactly matches "${agentTarget}". Run \`pi-intercom list\` on that machine to see session names.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple live Pi agents on ${where} exactly match "${agentTarget}"; target is ambiguous.`);
  }
  return matches[0]!;
}

export async function discoverRemoteAgent(target: string, deps: DiscoveryDeps): Promise<DiscoveredRemoteAgent> {
  const explicit = parseCrossMachineTarget(target);
  // Herdr is optional. Without it, or without a saved machine by this label, the label is an SSH host.
  const saved = (await listSavedMachines(deps).catch(() => [])).filter((machine) => (
    machine.label.toLowerCase() === explicit.machineLabel.toLowerCase()
  ));
  const selected = saved.filter((machine) => machine.enabled);
  if (selected.length > 1) {
    throw new Error(`Saved Herdr machine label "${explicit.machineLabel}" is ambiguous; expected exactly one enabled machine.`);
  }
  if (selected.length === 1) {
    const machine = selected[0]!;
    const agents = await listMachineAgents(machine, deps);
    return { machine, agent: selectAgent(agents, explicit.agentTarget, `saved Herdr machine "${machine.label}"`) };
  }
  if (saved.length > 0) {
    throw new Error(`Saved Herdr machine "${explicit.machineLabel}" is disabled; enable it in Herdr to send there.`);
  }

  const host = explicit.machineLabel;
  if (!SSH_HOST.test(host)) {
    throw new Error(`"${host}" is not a saved Herdr machine or a valid SSH host name; use a host name or ~/.ssh/config alias (letters, digits, ".", "_", "-").`);
  }
  const agents = await listSshAgents(host, deps);
  return {
    machine: { label: host, target: host, enabled: true },
    agent: selectAgent(agents, explicit.agentTarget, `"${host}"`),
    viaSsh: true,
  };
}
