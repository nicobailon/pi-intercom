import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatHandoverMessage, generateHandoverBody, readGitState, selectHandoverMessages } from "./handover.ts";

function messageEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-30T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  } as SessionEntry;
}

test("selectHandoverMessages keeps message entries when the branch was never compacted", () => {
  const branch = [
    messageEntry("a", "first"),
    { type: "label", id: "l", parentId: "a", timestamp: "2026-09-30T00:00:00.000Z", targetId: "a", label: "x" } as unknown as SessionEntry,
    messageEntry("b", "second"),
  ];
  assert.deepEqual(selectHandoverMessages(branch).map((message) => (message as { content: string }).content), ["first", "second"]);
});

test("selectHandoverMessages starts from the latest compaction summary and its kept entries", () => {
  const branch = [
    messageEntry("a", "summarized away"),
    messageEntry("b", "kept"),
    { type: "compaction", id: "c", parentId: "b", timestamp: "2026-09-30T00:00:00.000Z", summary: "earlier work", firstKeptEntryId: "b", tokensBefore: 10 } as SessionEntry,
    messageEntry("d", "after"),
  ];
  const selected = selectHandoverMessages(branch);
  assert.deepEqual(selected.map((message) => message.role), ["compactionSummary", "user", "user"]);
  assert.equal((selected[0] as { summary: string }).summary, "earlier work");
  assert.deepEqual(selected.slice(1).map((message) => (message as { content: string }).content), ["kept", "after"]);
});

test("formatHandoverMessage includes the session file and git state only when known", () => {
  const local = formatHandoverMessage({
    senderName: "planner",
    senderCwd: "/work/pi-intercom",
    sessionFile: "/home/me/.pi/sessions/a.jsonl",
    git: { branch: "main", head: "69a9c44879a6" },
    body: "## Next task\nShip it",
  });
  assert.match(local, /^# Handover from planner\n/);
  assert.match(local, /Sender working directory: \/work\/pi-intercom/);
  assert.match(local, /Sender git state: branch main at 69a9c44879a6/);
  assert.match(local, /Sender session file: \/home\/me\/\.pi\/sessions\/a\.jsonl/);
  assert.match(local, /not instructions from your user/);
  assert.ok(local.endsWith("## Next task\nShip it"));

  const remote = formatHandoverMessage({ senderName: "planner", senderCwd: "/work/pi-intercom", body: "body" });
  assert.doesNotMatch(remote, /session file|git state/);
});

test("readGitState returns undefined outside a git repository", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-handover-"));
  try {
    assert.equal(await readGitState(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateHandoverBody reports why generation failed", async () => {
  const sessionManager = { getBranch: () => [messageEntry("a", "hello")] };
  const withResponse = (response: Record<string, unknown>) => ({
    model: { id: "m" },
    sessionManager,
    modelRegistry: { complete: async () => response },
  }) as never;

  await assert.rejects(generateHandoverBody({ model: undefined, sessionManager, modelRegistry: {} } as never, undefined, undefined), /No model selected/);
  await assert.rejects(generateHandoverBody({ model: { id: "m" }, sessionManager: { getBranch: () => [] }, modelRegistry: {} } as never, undefined, undefined), /No conversation/);
  await assert.rejects(generateHandoverBody(withResponse({ stopReason: "aborted", content: [] }), undefined, undefined), /aborted/);
  await assert.rejects(generateHandoverBody(withResponse({ stopReason: "error", errorMessage: "rate limited", content: [] }), undefined, undefined), /rate limited/);
  assert.equal(await generateHandoverBody(withResponse({ stopReason: "stop", content: [{ type: "text", text: " summary " }] }), "goal", undefined), "summary");
});
