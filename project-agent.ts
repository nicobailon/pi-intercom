import { spawn, type ChildProcess } from "child_process";
import { realpathSync, statSync } from "fs";
import { basename, resolve } from "path";
import type { ProjectPlacement } from "./config.ts";
import { sameCwd } from "./cwd.ts";
import type { SessionInfo } from "./types.ts";

const DEFAULT_PROJECT_AGENT_TIMEOUT_MS = 20_000;
const DEFAULT_PROJECT_AGENT_POLL_MS = 250;

export type HerdrErrorCode =
  | "HERDR_UNAVAILABLE"
  | "HERDR_UNSUPPORTED_VERSION"
  | "PANE_GONE"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "VALIDATION_ERROR";

export type HerdrResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } };

export interface HerdrClient {
  run<T = unknown>(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; textOk?: boolean }): Promise<HerdrResult<T>>;
}

type SpawnHerdr = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface ProjectPaneLaunch {
  /** Herdr TUI pane id, or herdr-core terminal address under the Herdr app. */
  paneId: string;
  projectRoot: string;
  command: string;
}

/** Which Herdr hosts this process. The TUI wins when nested inside an app terminal. */
export type HerdrHost = { kind: "tui"; paneId: string } | { kind: "app"; terminalId: string };

export function currentHerdrHost(env: NodeJS.ProcessEnv = process.env): HerdrHost | undefined {
  const paneId = env.HERDR_PANE_ID?.trim();
  if (paneId) return { kind: "tui", paneId };
  const terminalId = env.HC_TERMINAL_ID?.trim();
  if (terminalId) return { kind: "app", terminalId };
  return undefined;
}

const TUI_MISSING = "Herdr is not installed or is not on PATH. Install Herdr 0.7.5+ or set HERDR_BIN. With the Herdr desktop app, run Pi in a Herdr terminal.";
const HC_MISSING = "herdr-core's 'hc' is not on PATH. Install the Herdr desktop app (herdr-app with herdr-core).";
const APP_MISSING = "'herdr-app' is not on PATH. Install the Herdr desktop app.";

export interface ProjectTargetResolution {
  kind: "found" | "missing";
  session?: SessionInfo;
  targetCwd: string;
  reason?: string;
}

export interface ListSessionsClient {
  listSessions(options?: { timeoutMs?: number }): Promise<SessionInfo[]>;
}

function error(code: HerdrErrorCode, message: string, details?: unknown): HerdrResult<never> {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function parseLastJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch {}
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as unknown; } catch {}
  }
  return undefined;
}

function normalizeCode(raw: unknown): HerdrErrorCode {
  const code = String(raw ?? "").toLowerCase();
  if (code.includes("timeout") || code.includes("timed_out")) return "TIMEOUT";
  if (code.includes("gone")) return "PANE_GONE";
  if (code.includes("not_found") || code.includes("not-found") || code === "no_such_pane") return "NOT_FOUND";
  return "VALIDATION_ERROR";
}

export function createHerdrClient(options: { bin?: string; spawn?: SpawnHerdr; missingMessage?: string } = {}): HerdrClient {
  const bin = options.bin ?? process.env.HERDR_BIN ?? "herdr";
  const missingMessage = options.missingMessage ?? TUI_MISSING;
  const spawnImpl = options.spawn ?? spawn;
  return {
    run<T>(args: string[], runOptions: { timeoutMs?: number; signal?: AbortSignal; textOk?: boolean } = {}): Promise<HerdrResult<T>> {
      return new Promise((resolveResult) => {
        let child: ChildProcess;
        try {
          child = spawnImpl(bin, args, { shell: false, windowsHide: true, env: process.env });
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          resolveResult(error("HERDR_UNAVAILABLE", code === "ENOENT"
            ? missingMessage
            : `Failed to start Herdr: ${cause instanceof Error ? cause.message : String(cause)}`));
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: HerdrResult<T>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          runOptions.signal?.removeEventListener("abort", abort);
          resolveResult(result);
        };
        const abort = () => {
          child.kill();
          finish(error("TIMEOUT", `Herdr command '${args.join(" ")}' was aborted.`));
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(error("TIMEOUT", `Herdr command '${args.join(" ")}' timed out after ${runOptions.timeoutMs ?? 15_000}ms.`));
        }, runOptions.timeoutMs ?? 15_000);
        timer.unref?.();

        if (runOptions.signal?.aborted) abort();
        else runOptions.signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (cause) => {
          const code = (cause as NodeJS.ErrnoException).code;
          finish(error("HERDR_UNAVAILABLE", code === "ENOENT"
            ? missingMessage
            : `Failed to run Herdr: ${cause.message}`));
        });
        child.on("close", (exitCode) => {
          const parsed = parseLastJson(stdout) ?? (exitCode === 0 ? undefined : parseLastJson(stderr));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
            // TUI and hc errors are {code|kind, message}; herdr-app's are a bare string.
            const raw = (parsed as { error?: unknown }).error;
            const fields = typeof raw === "string" ? { message: raw } : raw as { code?: unknown; kind?: unknown; message?: unknown } | undefined;
            finish(error(normalizeCode(fields?.code ?? fields?.kind), String(fields?.message ?? "Herdr command failed."), raw));
            return;
          }
          if (exitCode === 0) {
            if (parsed !== undefined) {
              const envelope = parsed as { result?: unknown };
              finish({ ok: true, data: (envelope.result ?? parsed) as T });
            } else if (runOptions.textOk) {
              finish({ ok: true, data: stdout.trim() as T });
            } else {
              finish({ ok: true, data: {} as T });
            }
            return;
          }
          const message = stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? `Herdr exited with code ${exitCode}.`;
          finish(error("VALIDATION_ERROR", message, { exitCode }));
        });
      });
    },
  };
}

function formatHerdrError(input: { code: HerdrErrorCode; message: string }): string {
  return `Herdr project pane error (${input.code}): ${input.message}`;
}

function parseHerdrVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

function supportsRawPanes(version: { major: number; minor: number; patch: number }): boolean {
  return version.major > 0 || version.minor > 7 || (version.minor === 7 && version.patch >= 5);
}

async function detectHerdr(client: HerdrClient, signal?: AbortSignal): Promise<HerdrResult<{ versionText: string }>> {
  const result = await client.run<string>(["--version"], { timeoutMs: 3_000, signal, textOk: true });
  if (result.ok === false) return result;
  const versionText = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  const version = parseHerdrVersion(versionText);
  if (!version) return error("VALIDATION_ERROR", `Could not parse the Herdr version from '${versionText}'.`);
  if (!supportsRawPanes(version)) return error("HERDR_UNSUPPORTED_VERSION", `Herdr ${versionText} does not support raw panes. Upgrade to Herdr 0.7.5 or newer.`);
  return { ok: true, data: { versionText } };
}

function extractPaneId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pane = record.pane && typeof record.pane === "object" && !Array.isArray(record.pane) ? record.pane as Record<string, unknown> : record;
  for (const key of ["pane_id", "paneId", "id"]) {
    if (typeof pane[key] === "string") return pane[key];
  }
  return undefined;
}

function resolveProjectRoot(cwd: string): string {
  const resolved = resolve(cwd);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project target '${resolved}' is not a directory.`);
  }
  return realpathSync(resolved);
}

export function resolveTargetInCwd(input: {
  sessions: SessionInfo[];
  currentSessionId: string;
  targetCwd: string;
  to?: string;
}): ProjectTargetResolution {
  const inCwd = input.sessions.filter((session) => sameCwd(session.cwd, input.targetCwd));
  const target = input.to?.trim();

  if (!target) {
    const candidates = inCwd.filter((session) => session.id !== input.currentSessionId);
    if (candidates.length === 1) {
      return { kind: "found", session: candidates[0], targetCwd: input.targetCwd };
    }
    if (candidates.length === 0) {
      return { kind: "missing", targetCwd: input.targetCwd, reason: `No other intercom sessions are connected in ${input.targetCwd}.` };
    }
    throw new Error(`Multiple intercom sessions are connected in ${input.targetCwd}: ${formatSessionRefs(candidates)}. Specify 'to'.`);
  }

  const byId = inCwd.find((session) => session.id === target);
  if (byId) return { kind: "found", session: byId, targetCwd: input.targetCwd };

  const lowerName = target.toLowerCase();
  const byName = inCwd.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length === 1) return { kind: "found", session: byName[0], targetCwd: input.targetCwd };
  if (byName.length > 1) {
    throw new Error(`Multiple intercom sessions named "${target}" are connected in ${input.targetCwd}: ${formatSessionRefs(byName)}. Address one by session ID.`);
  }

  const byIdPrefix = inCwd.filter((session) => session.id.startsWith(target));
  if (byIdPrefix.length === 1) return { kind: "found", session: byIdPrefix[0], targetCwd: input.targetCwd };
  if (byIdPrefix.length > 1) {
    throw new Error(`Multiple intercom sessions in ${input.targetCwd} match ID prefix "${target}". Use a longer session ID prefix.`);
  }

  return { kind: "missing", targetCwd: input.targetCwd, reason: `No intercom session matching "${target}" is connected in ${input.targetCwd}.` };
}

function projectCommand(): string {
  return process.env.PI_INTERCOM_PI_BIN?.trim() || process.env.PI_BIN?.trim() || "pi";
}

/** Open a Pi pane for a project in whichever Herdr hosts this session. `placement` applies to the Herdr app only. */
export function openProjectPane(input: { cwd: string; focus?: boolean; placement?: ProjectPlacement; signal?: AbortSignal }): Promise<ProjectPaneLaunch> {
  const host = currentHerdrHost();
  return host?.kind === "app"
    ? openHerdrAppPane({ ...input, terminalId: host.terminalId })
    : openHerdrTuiPane(input);
}

export async function openHerdrTuiPane(input: {
  cwd: string;
  focus?: boolean;
  client?: HerdrClient;
  signal?: AbortSignal;
}): Promise<ProjectPaneLaunch> {
  const projectRoot = resolveProjectRoot(input.cwd);
  const client = input.client ?? createHerdrClient();
  const detected = await detectHerdr(client, input.signal);
  if (detected.ok === false) throw new Error(formatHerdrError(detected.error));

  const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", projectRoot];
  if (input.focus !== false) splitArgs.push("--focus");
  const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: input.signal });
  if (split.ok === false) throw new Error(formatHerdrError(split.error));
  const paneId = extractPaneId(split.data);
  if (!paneId) throw new Error("Herdr project pane error (PANE_GONE): pane split returned no pane id.");

  const command = projectCommand();
  const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: input.signal });
  if (started.ok === false) {
    await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
    throw new Error(formatHerdrError(started.error));
  }

  return { paneId, projectRoot, command };
}

/**
 * Herdr app: start Pi in a herdr-core terminal labeled with the caller's space
 * and tab, which the window shows as a split beside the caller (the TUI's
 * `pane split --current --direction right`).
 */
export async function openHerdrAppPane(input: {
  cwd: string;
  focus?: boolean;
  placement?: ProjectPlacement;
  terminalId: string;
  hc?: HerdrClient;
  app?: HerdrClient;
  signal?: AbortSignal;
}): Promise<ProjectPaneLaunch> {
  const projectRoot = resolveProjectRoot(input.cwd);
  const hc = input.hc ?? createHerdrClient({ bin: "hc", missingMessage: HC_MISSING });
  const caller = await hc.run<{ labels?: Record<string, unknown> }>(["get", input.terminalId, "--json"], { timeoutMs: 5_000, signal: input.signal });
  if (caller.ok === false) throw new Error(formatHerdrError(caller.error));
  const space = caller.data.labels?.["herdr.space"];
  const tab = caller.data.labels?.["herdr.tab"];
  if (typeof space !== "string" || typeof tab !== "string") {
    throw new Error(`Herdr project pane error (NOT_FOUND): terminal ${input.terminalId} is not shown in the Herdr window (no herdr.space/herdr.tab labels).`);
  }

  const app = input.app ?? createHerdrClient({ bin: "herdr-app", missingMessage: APP_MISSING });
  const command = projectCommand();
  let labels = ["--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`];
  if (input.placement === "space") {
    const target = await spaceForFolder(app, space, projectRoot, input.signal);
    if (target === "new") {
      // space.new shows and focuses the new space itself, whatever `focus` says.
      const args = { name: basename(projectRoot) || undefined, folder: projectRoot, argv: ["sh", "-c", command] };
      const created = await app.run<{ terminal?: unknown }>(["do", "space.new", JSON.stringify(args)], { timeoutMs: 15_000, signal: input.signal });
      if (created.ok === false) throw new Error(formatHerdrError(created.error));
      if (typeof created.data.terminal !== "string") throw new Error("Herdr project pane error (PANE_GONE): space.new returned no terminal.");
      return { paneId: created.data.terminal, projectRoot, command };
    }
    // Without a tab label, the window opens the terminal in a new tab of that space.
    if (target) labels = ["--label", `herdr.space=${target}`];
  }

  // --no-parent: the peer must outlive the caller. --keep: a shell stays in the pane when Pi exits, as in the TUI.
  const started = await hc.run<{ address?: unknown }>([
    "run", "--bg", "--json", "--no-parent", "--keep", "--cwd", projectRoot, ...labels, "--", command,
  ], { timeoutMs: 15_000, signal: input.signal });
  if (started.ok === false) throw new Error(formatHerdrError(started.error));
  const terminal = started.data.address;
  if (typeof terminal !== "string") throw new Error("Herdr project pane error (PANE_GONE): hc run returned no terminal address.");

  if (input.focus !== false) {
    // Focus is cosmetic: the terminal already runs, so a missing or closed window must not fail the launch.
    // The window picks up a new labeled terminal shortly after hc run returns: retry for up to ~2s.
    for (let attempt = 0; attempt < 20; attempt++) {
      const focused = await app.run(["do", "pane.focus", "--terminal", terminal], { timeoutMs: 5_000, signal: input.signal });
      if (focused.ok || focused.error.code === "HERDR_UNAVAILABLE" || input.signal?.aborted) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }

  return { paneId: terminal, projectRoot, command };
}

/**
 * For placement "space": undefined keeps the pane beside the caller (the
 * caller's space has exactly this folder), a space id reuses the local space
 * that has it, and "new" asks for a new space.
 */
async function spaceForFolder(app: HerdrClient, callerSpace: string, folder: string, signal?: AbortSignal): Promise<string | undefined> {
  const listed = await app.run<{ spaces?: Array<{ id?: unknown; folder?: unknown; machine?: unknown }> }>(["ls"], { timeoutMs: 5_000, signal });
  if (listed.ok === false) throw new Error(formatHerdrError(listed.error));
  const spaces = Array.isArray(listed.data.spaces) ? listed.data.spaces : [];
  const hasFolder = (space: { folder?: unknown; machine?: unknown }) =>
    space.machine == null && typeof space.folder === "string" && sameCwd(space.folder, folder);
  if (spaces.some((space) => space.id === callerSpace && hasFolder(space))) return undefined;
  const existing = spaces.find(hasFolder)?.id;
  return typeof existing === "string" ? existing : "new";
}

export async function waitForProjectSession(client: ListSessionsClient, input: {
  projectRoot: string;
  currentSessionId: string;
  beforeSessionIds: ReadonlySet<string>;
  to?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<SessionInfo> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROJECT_AGENT_TIMEOUT_MS;
  const pollMs = input.pollMs ?? DEFAULT_PROJECT_AGENT_POLL_MS;

  while (Date.now() - startedAt < timeoutMs) {
    if (input.signal?.aborted) throw new Error("Cancelled");
    const sessions = await client.listSessions({ timeoutMs: Math.min(5_000, timeoutMs) });

    if (input.to?.trim()) {
      const resolved = resolveTargetInCwd({
        sessions,
        currentSessionId: input.currentSessionId,
        targetCwd: input.projectRoot,
        to: input.to,
      });
      if (resolved.kind === "found" && resolved.session) return resolved.session;
      await sleep(pollMs, input.signal);
      continue;
    }

    const newInProject = sessions.filter(
      (session) => !input.beforeSessionIds.has(session.id) && sameCwd(session.cwd, input.projectRoot),
    );
    if (newInProject.length === 1) return newInProject[0]!;
    if (newInProject.length > 1) {
      throw new Error(`Multiple new intercom sessions registered in ${input.projectRoot}: ${formatSessionRefs(newInProject)}. Address one explicitly.`);
    }

    await sleep(pollMs, input.signal);
  }

  throw new Error(`Timed out waiting for a Pi intercom session to register in ${input.projectRoot}. The Herdr pane may still be starting, or pi-intercom may not be loaded there.`);
}

function formatSessionRefs(sessions: SessionInfo[]): string {
  return sessions
    .map((session) => `${session.name || "Unnamed session"} (${session.id.slice(0, 8)})`)
    .join(", ");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Cancelled"));
    };
    timer = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
