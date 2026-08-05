import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WORK_SUMMARY_MAX_BYTES,
  WORK_SUMMARY_MAX_COLUMNS,
  findManagedWorkSummary,
  isValidWorkSummary,
  localJobsPath,
  normalizeWorkSummary,
  readManagedWorkSummary,
  watchManagedWorkSummary,
} from "./work-summary.ts";

function jobBlock(options: {
  id: string;
  title: string;
  status: string;
  ownerPiSessionId: string;
  handoff?: string;
}): string {
  return `### ${options.id}\n\n\`\`\`yaml\nid: ${options.id}\ntitle: ${options.title}\nstatus: ${options.status}\nowner:\n  pi_session_id: ${options.ownerPiSessionId}\n  name: worker\nworkspace:\n  path: /private/customer/repository\nhandoff: ${options.handoff ?? "null"}\n\`\`\``;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for work-summary update");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("normalizeWorkSummary makes one safe line and strips control characters", () => {
  assert.equal(normalizeWorkSummary("  Implement\n\tlocal\x1b[31m summaries\u009b  "), "Implement local [31m summaries");
  assert.equal(normalizeWorkSummary("\n\t\x00"), undefined);
  assert.equal(isValidWorkSummary("Implement local summaries"), true);
  assert.equal(isValidWorkSummary("Implement\nlocal summaries"), false);
  assert.equal(normalizeWorkSummary("Inspect /Users/example/private-repo/file.ts"), undefined);
  assert.equal(normalizeWorkSummary("Debug password=example-value"), undefined);
  assert.equal(normalizeWorkSummary("Fix the /sessions endpoint"), "Fix the /sessions endpoint");
  assert.equal(normalizeWorkSummary("Review\u202ea misleading title"), "Review a misleading title");
});

test("normalizeWorkSummary enforces visible-column and UTF-8 byte bounds without splitting graphemes", () => {
  const ascii = normalizeWorkSummary("a".repeat(300));
  assert.ok(ascii?.endsWith("…"));
  assert.ok(visibleWidth(ascii ?? "") <= WORK_SUMMARY_MAX_COLUMNS);
  assert.ok(Buffer.byteLength(ascii ?? "", "utf8") <= WORK_SUMMARY_MAX_BYTES);

  const cjk = normalizeWorkSummary("漢".repeat(200));
  assert.ok(cjk?.endsWith("…"));
  assert.ok(visibleWidth(cjk ?? "") <= WORK_SUMMARY_MAX_COLUMNS);
  assert.ok(Buffer.byteLength(cjk ?? "", "utf8") <= WORK_SUMMARY_MAX_BYTES);

  const family = "👨‍👩‍👧‍👦";
  const emoji = normalizeWorkSummary(family.repeat(100));
  assert.ok(emoji?.endsWith("…"));
  assert.equal((emoji ?? "").slice(0, -1).replaceAll(family, ""), "");
});

test("findManagedWorkSummary joins active jobs by immutable Pi session ID and returns only the title", () => {
  const markdown = [
    jobBlock({ id: "LJ-001", title: "Old completed work", status: "done", ownerPiSessionId: "pi-target" }),
    jobBlock({
      id: "LJ-006",
      title: "Show brief work summaries",
      status: "active",
      ownerPiSessionId: "pi-target",
      handoff: "secret body and /private/customer/path",
    }),
    jobBlock({ id: "LJ-007", title: "Different worker", status: "active", ownerPiSessionId: "pi-other" }),
  ].join("\n\n");

  assert.equal(findManagedWorkSummary({ markdown, piSessionId: "pi-target" }), "Show brief work summaries");
  assert.equal(findManagedWorkSummary({ markdown, piSessionId: "pi-missing" }), undefined);
  assert.doesNotMatch(findManagedWorkSummary({ markdown, piSessionId: "pi-target" }) ?? "", /secret|private|customer/u);
});

test("findManagedWorkSummary accepts the ledger's inline-owner form and YAML scalar comments", () => {
  const markdown = "```yaml\ntitle: Inline owner task # safe comment\nstatus: blocked # retained owner\nowner: { pi_session_id: pi-target, name: worker }\n```";
  assert.equal(findManagedWorkSummary({ markdown, piSessionId: "pi-target" }), "Inline owner task");
  assert.equal(findManagedWorkSummary({ markdown, piSessionId: "pi-tar" }), undefined);
});

test("findManagedWorkSummary omits malformed, unowned, and terminal jobs", () => {
  const markdown = [
    "```yaml\ntitle: |\n  multiline content\nstatus: active\nowner:\n  pi_session_id: pi-target\n```",
    jobBlock({ id: "LJ-002", title: "Ready but unclaimed", status: "ready", ownerPiSessionId: "pi-target" }),
    "```yaml\ntitle: Missing owner\nstatus: active\nowner: null\n```",
  ].join("\n\n");
  assert.equal(findManagedWorkSummary({ markdown, piSessionId: "pi-target" }), undefined);
});

test("localJobsPath uses the default centralized Pi agent root", () => {
  assert.equal(
    localJobsPath({}, "/home/example", "/workspace/project"),
    join("/home/example", ".pi", "agent", "LOCAL_JOBS.md"),
  );
});

test("localJobsPath honors an absolute PI_CODING_AGENT_DIR", () => {
  assert.equal(
    localJobsPath({ PI_CODING_AGENT_DIR: "/custom/pi-agent" }, "/home/example", "/workspace/project"),
    join("/custom/pi-agent", "LOCAL_JOBS.md"),
  );
});

test("localJobsPath resolves a relative PI_CODING_AGENT_DIR from cwd", () => {
  assert.equal(
    localJobsPath({ PI_CODING_AGENT_DIR: "relative-agent" }, "/home/example", "/workspace/project"),
    join("/workspace/project", "relative-agent", "LOCAL_JOBS.md"),
  );
});

test("readManagedWorkSummary fails closed for missing files and parses quoted titles", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-work-summary-"));
  const path = join(directory, "LOCAL_JOBS.md");
  try {
    assert.equal(readManagedWorkSummary({ piSessionId: "pi-target", path }), undefined);
    writeFileSync(path, jobBlock({ id: "LJ-006", title: '"Quoted work title"', status: "claimed", ownerPiSessionId: "pi-target" }));
    assert.equal(readManagedWorkSummary({ piSessionId: "pi-target", path }), "Quoted work title");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watchManagedWorkSummary emits only when the matched job title changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-work-summary-watch-"));
  const path = join(directory, "LOCAL_JOBS.md");
  const updates: Array<string | undefined> = [];
  writeFileSync(path, jobBlock({ id: "LJ-006", title: "Initial task", status: "active", ownerPiSessionId: "pi-target" }));
  const subscription = watchManagedWorkSummary({
    piSessionId: "pi-target",
    path,
    debounceMs: 10,
    onChange: (summary) => updates.push(summary),
  });
  assert.equal(subscription.summary, "Initial task");
  try {
    const replacementPath = join(directory, "LOCAL_JOBS.next.md");
    writeFileSync(replacementPath, jobBlock({ id: "LJ-006", title: "Updated task", status: "active", ownerPiSessionId: "pi-target" }));
    renameSync(replacementPath, path);
    await waitFor(() => updates.length === 1);
    assert.deepEqual(updates, ["Updated task"]);

    writeFileSync(path, jobBlock({ id: "LJ-006", title: "Updated task", status: "active", ownerPiSessionId: "pi-target" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(updates, ["Updated task"]);

    writeFileSync(path, jobBlock({ id: "LJ-006", title: "Updated task", status: "done", ownerPiSessionId: "pi-target" }));
    await waitFor(() => updates.length === 2);
    assert.deepEqual(updates, ["Updated task", undefined]);
  } finally {
    subscription.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
