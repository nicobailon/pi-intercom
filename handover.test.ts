import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { formatHandoverMessage, generateHandoverBody, readGitState } from "./handover.ts";

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: 0 };
}

function handoverContext(sessionManager: unknown, response: Record<string, unknown>, requests: string[] = []) {
  return {
    model: { id: "m" },
    sessionManager,
    modelRegistry: {
      complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
        requests.push(context.messages[0]!.content[0]!.text);
        return response;
      },
    },
  } as never;
}

test("generateHandoverBody summarizes the context Pi would send to the model", async () => {
  const session = SessionManager.inMemory(tmpdir());
  const early = session.appendMessage(user("early work"));
  session.appendCompaction("first summary", early, 10);
  const secret = session.appendMessage(user("secret original"));
  session.appendContextEdit(secret, { content: "redacted" });
  session.appendCompaction("second summary", secret, 20);
  session.branchWithSummary(session.getLeafId(), "explored another approach");
  session.appendMessage(user("latest request"));

  const requests: string[] = [];
  await generateHandoverBody(handoverContext(session, { stopReason: "stop", content: [{ type: "text", text: "body" }] }, requests), "next", undefined);

  const conversation = requests[0]!;
  for (const expected of ["second summary", "redacted", "explored another approach", "latest request"]) {
    assert.ok(conversation.includes(expected), `expected ${expected}`);
  }
  for (const excluded of ["first summary", "secret original", "early work"]) {
    assert.ok(!conversation.includes(excluded), `unexpected ${excluded}`);
  }
});

test("generateHandoverBody reports why generation failed", async () => {
  const session = SessionManager.inMemory(tmpdir());
  session.appendMessage(user("hello"));

  await assert.rejects(generateHandoverBody({ model: undefined, sessionManager: session, modelRegistry: {} } as never, undefined, undefined), /No model selected/);
  await assert.rejects(generateHandoverBody({ model: { id: "m" }, sessionManager: SessionManager.inMemory(tmpdir()), modelRegistry: {} } as never, undefined, undefined), /No conversation/);
  await assert.rejects(generateHandoverBody(handoverContext(session, { stopReason: "aborted", content: [] }), undefined, undefined), /aborted/);
  await assert.rejects(generateHandoverBody(handoverContext(session, { stopReason: "error", errorMessage: "rate limited", content: [] }), undefined, undefined), /rate limited/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(generateHandoverBody(handoverContext(session, { stopReason: "stop", content: [{ type: "text", text: "summary" }] }), undefined, aborted.signal), /aborted/);
  assert.equal(await generateHandoverBody(handoverContext(session, { stopReason: "stop", content: [{ type: "text", text: " summary " }] }), "goal", undefined), "summary");
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
