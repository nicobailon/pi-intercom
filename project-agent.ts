import { spawn, type ChildProcess } from "child_process";
import { realpathSync, statSync } from "fs";
import { resolve } from "path";
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
  paneId: string;
  projectRoot: string;
  command: string;
  herdrVersion: string;
}

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

function createHerdrClient(options: { bin?: string; spawn?: SpawnHerdr } = {}): HerdrClient {
  const bin = options.bin ?? process.env.HERDR_BIN ?? "herdr";
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
            ? "Herdr is not installed or is not on PATH. Install Herdr 0.7.5+ or set HERDR_BIN."
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
            ? "Herdr is not installed or is not on PATH. Install Herdr 0.7.5+ or set HERDR_BIN."
            : `Failed to run Herdr: ${cause.message}`));
        });
        child.on("close", (exitCode) => {
          const parsed = parseLastJson(stdout) ?? (exitCode === 0 ? undefined : parseLastJson(stderr));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
            const raw = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
            finish(error(normalizeCode(raw?.code), String(raw?.message ?? "Herdr command failed."), raw));
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

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
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

export async function openProjectPane(input: {
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

  const command = shellQuote(process.env.PI_INTERCOM_PI_BIN?.trim() || process.env.PI_BIN?.trim() || "pi");
  const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: input.signal });
  if (started.ok === false) {
    await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
    throw new Error(formatHerdrError(started.error));
  }

  return { paneId, projectRoot, command, herdrVersion: detected.data.versionText };
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
