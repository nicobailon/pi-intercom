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
}

export interface DiscoveredRemoteAgent {
  machine: SavedMachine;
  agent: RemoteAgent;
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
}

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
    return [{ name, ...(sessionId ? { sessionId } : {}) }];
  });
}

export function parseCrossMachineTarget(target: string): { agentTarget: string; machineLabel: string } {
  const parts = target.split("@");
  if (parts.length !== 2 || parts.some((part) => !part || /\s/.test(part))) {
    throw new Error(`Invalid remote target "${target}"; expected name@machine or full-session-uuid@machine.`);
  }
  return { agentTarget: parts[0], machineLabel: parts[1] };
}

export async function discoverRemoteAgent(target: string, deps: DiscoveryDeps): Promise<DiscoveredRemoteAgent> {
  const explicit = parseCrossMachineTarget(target);
  const discoveryTimeoutMs = deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const listed = await deps.run(deps.herdrBin, ["machine", "list", "--json"], undefined, discoveryTimeoutMs);
  if (listed.code !== 0) throw new Error(`Could not list Herdr saved machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
  const selected = parseSavedMachines(listed.stdout).filter((machine) => (
    machine.enabled && machine.label.toLowerCase() === explicit.machineLabel.toLowerCase()
  ));
  if (selected.length === 0) {
    throw new Error(`Saved Herdr machine "${explicit.machineLabel}" is unknown or disabled.`);
  }
  if (selected.length > 1) {
    throw new Error(`Saved Herdr machine label "${explicit.machineLabel}" is ambiguous; expected exactly one enabled machine.`);
  }

  const machine = selected[0]!;
  const result = await deps.run(deps.herdrBin, ["--machine", machine.label, "agent", "list"], undefined, discoveryTimeoutMs);
  if (result.code !== 0) {
    const detail = result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`;
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail}.`);
  }
  let agents: RemoteAgent[];
  try {
    agents = parseRemoteAgents(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid response";
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail}`);
  }

  const bySessionId = FULL_SESSION_UUID.test(explicit.agentTarget);
  const matches = agents
    .filter((agent) => bySessionId
      ? agent.sessionId === explicit.agentTarget
      : agent.name.toLowerCase() === explicit.agentTarget.toLowerCase())
    .map((agent) => ({ machine, agent }));
  if (matches.length === 0) {
    throw new Error(`No live Pi agent on saved Herdr machine "${machine.label}" exactly matches "${explicit.agentTarget}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple live Pi agents on saved Herdr machine "${machine.label}" exactly match "${explicit.agentTarget}"; target is ambiguous.`);
  }

  return matches[0]!;
}
