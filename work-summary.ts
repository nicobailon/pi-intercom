import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getAgentDirPath } from "./broker/paths.ts";

export const WORK_SUMMARY_MAX_COLUMNS = 96;
export const WORK_SUMMARY_MAX_BYTES = 192;
const WATCH_DEBOUNCE_MS = 75;
const ACTIVE_JOB_STATUSES = new Set(["claimed", "active", "blocked", "review"]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SENSITIVE_SUMMARY_PATTERNS = [
  /(?:^|\s)\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt|Volumes)\/\S+/iu,
  /(?:^|\s)[a-z]:\\\S+/iu,
  /\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/iu,
  /\bBearer\s+\S+/iu,
  /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u,
] as const;

export type WorkSummaryWatchOptions = {
  piSessionId: string;
  path?: string;
  debounceMs?: number;
  onChange: (summary: string | undefined) => void;
};

export type WorkSummarySubscription = {
  summary: string | undefined;
  stop: () => void;
};

export function localJobsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
): string {
  return join(getAgentDirPath(env, homeDir, cwd), "LOCAL_JOBS.md");
}

function isWithinBounds(value: string): boolean {
  return visibleWidth(value) <= WORK_SUMMARY_MAX_COLUMNS
    && Buffer.byteLength(value, "utf8") <= WORK_SUMMARY_MAX_BYTES;
}

export function normalizeWorkSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || SENSITIVE_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized))) return undefined;
  if (isWithinBounds(normalized)) return normalized;

  const ellipsis = "…";
  let truncated = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(normalized)) {
    const candidate = `${truncated}${segment}${ellipsis}`;
    if (!isWithinBounds(candidate)) break;
    truncated += segment;
  }
  return truncated ? `${truncated}${ellipsis}` : ellipsis;
}

export function isValidWorkSummary(value: unknown): value is string {
  return typeof value === "string" && normalizeWorkSummary(value) === value;
}

function decodeYamlScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "|" || trimmed === ">") return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      return typeof decoded === "string" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

type ManagedJob = {
  title?: string;
  status?: string;
  ownerPiSessionId?: string;
};

function parseManagedJob(block: string): ManagedJob {
  const job: ManagedJob = {};
  let inOwner = false;
  for (const line of block.split(/\r?\n/u)) {
    const rootField = /^([a-zA-Z_][\w-]*):\s*(.*)$/u.exec(line);
    if (rootField) {
      inOwner = rootField[1] === "owner";
      if (rootField[1] === "title") job.title = decodeYamlScalar(rootField[2]);
      if (rootField[1] === "status") job.status = decodeYamlScalar(rootField[2]);
      if (inOwner) {
        const inlineOwner = /^\{(.*)\}$/u.exec(rootField[2].trim());
        for (const field of inlineOwner?.[1].split(",") ?? []) {
          const ownerField = /^\s*([a-zA-Z_][\w-]*):\s*(.*)$/u.exec(field);
          if (ownerField?.[1] === "pi_session_id") {
            job.ownerPiSessionId = decodeYamlScalar(ownerField[2]);
          }
        }
      }
      continue;
    }
    if (!inOwner) continue;
    const ownerField = /^\s+([a-zA-Z_][\w-]*):\s*(.*)$/u.exec(line);
    if (ownerField?.[1] === "pi_session_id") {
      job.ownerPiSessionId = decodeYamlScalar(ownerField[2]);
    }
  }
  return job;
}

export function findManagedWorkSummary(options: { markdown: string; piSessionId: string }): string | undefined {
  for (const match of options.markdown.matchAll(/```ya?ml\s*\n([\s\S]*?)```/giu)) {
    const job = parseManagedJob(match[1] ?? "");
    if (job.ownerPiSessionId !== options.piSessionId || !job.status || !ACTIVE_JOB_STATUSES.has(job.status)) continue;
    const summary = normalizeWorkSummary(job.title);
    if (summary) return summary;
  }
  return undefined;
}

export function readManagedWorkSummary(options: { piSessionId: string; path?: string }): string | undefined {
  const path = options.path ?? localJobsPath();
  try {
    if (!existsSync(path)) return undefined;
    return findManagedWorkSummary({ markdown: readFileSync(path, "utf8"), piSessionId: options.piSessionId });
  } catch {
    return undefined;
  }
}

export function watchManagedWorkSummary(options: WorkSummaryWatchOptions): WorkSummarySubscription {
  const path = options.path ?? localJobsPath();
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  let current: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const refresh = (): void => {
    timer = undefined;
    const next = readManagedWorkSummary({ piSessionId: options.piSessionId, path });
    if (next === current) return;
    current = next;
    options.onChange(next);
  };
  const scheduleRefresh = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
    timer.unref?.();
  };

  try {
    watcher = watch(dirname(path), (_eventType, filename) => {
      if (filename !== null && filename.toString() !== basename(path)) return;
      scheduleRefresh();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      scheduleRefresh();
    });
    watcher.unref?.();
    // Read after subscribing so a ledger update cannot land in the gap between
    // the initial snapshot and watcher registration.
    current = readManagedWorkSummary({ piSessionId: options.piSessionId, path });
  } catch {
    return {
      summary: readManagedWorkSummary({ piSessionId: options.piSessionId, path }),
      stop: () => {},
    };
  }

  return {
    summary: current,
    stop: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
