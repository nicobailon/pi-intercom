import test from "node:test";
import assert from "node:assert/strict";
import { ReplyTracker } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

function createSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/tmp/project",
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
}

function createMessage(id: string, text: string, expectsReply = true): Message {
  return {
    id,
    timestamp: 1,
    expectsReply,
    content: { text },
  };
}

test("reply resolves from current triggered message context", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const message = createMessage("ask-1", "Need a decision");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
  assert.equal(tracker.resolveReplyTarget({}, 1002).from.id, "planner-id");
});

test("reply resolves from single pending ask without current turn context", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.resolveReplyTarget({}, 1001).message.id, "ask-1");
});

test("reply with to resolves matching pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ to: "planner-id" }, 1002).message.id, "ask-1");
});

test("reply errors when no context and no pending asks", () => {
  const tracker = new ReplyTracker();

  assert.throws(() => tracker.resolveReplyTarget({}, 1000), /No active intercom context to reply to/);
});

test("reply errors when multiple pending asks and no to", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Multiple pending asks — specify `to`/);
});

test("reply removes pending ask after successful reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.markReplied("ask-1");

  assert.deepEqual(tracker.listPending(1001), []);
});

// --- Fix 2: Long timeout for deployment chains ---

test("pending ask survives past 10 minutes with default timeout (60 min)", () => {
  // Deployment chains routinely take 30-60+ minutes.
  // BUG: The OLD default was 10 min — deployment asks expired mid-chain.
  // FIX: Default timeout increased to 60 minutes.
  // This test must pass with the NEW default (60 min) and fail with the OLD (10 min).
  const tracker = new ReplyTracker(); // Use default timeout

  tracker.recordIncomingMessage(
    createSession("orchestrator-id", "orchestrator"),
    createMessage("ask-deploy", "Deploy to prod?"),
    1000,
  );

  // After 30 minutes (typical deployment duration), ask should still be pending
  const thirtyMinLater = 1000 + 30 * 60 * 1000;
  assert.equal(tracker.resolveReplyTarget({}, thirtyMinLater).message.id, "ask-deploy");
});

test("pending ask expires after 60 minutes with new default timeout", () => {
  const SIXTY_MIN = 60 * 60 * 1000;
  const tracker = new ReplyTracker(SIXTY_MIN);

  tracker.recordIncomingMessage(
    createSession("orchestrator-id", "orchestrator"),
    createMessage("ask-deploy", "Deploy to prod?"),
    1000,
  );

  // After 61 minutes, should be expired
  const sixtyOneMinLater = 1000 + 61 * 60 * 1000;
  assert.throws(
    () => tracker.resolveReplyTarget({}, sixtyOneMinLater),
    /No active intercom context to reply to/,
  );
});

test("pending ask survives endTurn and can be replied later from pendingAsks", () => {
  // Scenario: ask triggers a turn, agent processes but doesn't reply in that turn,
  // turn ends, agent replies in a later turn from pendingAsks
  const tracker = new ReplyTracker(60 * 60 * 1000);
  const from = createSession("orchestrator-id", "orchestrator");
  const message = createMessage("ask-1", "Deploy?");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  // Agent processes but doesn't reply — turn ends
  tracker.endTurn();

  // Later, agent wants to reply — should find it in pendingAsks
  assert.equal(tracker.resolveReplyTarget({}, 2000).message.id, "ask-1");
});

test("markReplied removes from pendingAsks so auto-replied asks cannot be manually replied", () => {
  // This test documents the BUG: if markReplied is called by the auto-reply
  // for expectsReply messages, the agent later can't reply.
  // The fix is in index.ts (not here) — this test just verifies the tracker behavior
  // that when markReplied IS called, the ask is gone.
  const tracker = new ReplyTracker(60 * 60 * 1000);
  tracker.recordIncomingMessage(
    createSession("orchestrator-id", "orchestrator"),
    createMessage("ask-1", "Deploy?"),
    1000,
  );

  // Simulate auto-reply calling markReplied (the bug in index.ts)
  tracker.markReplied("ask-1");

  // Now agent tries to reply — should fail
  assert.throws(
    () => tracker.resolveReplyTarget({}, 1002),
    /No active intercom context to reply to/,
  );
});

test("send message (expectsReply=false) is NOT added to pendingAsks", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(
    createSession("orchestrator-id", "orchestrator"),
    createMessage("msg-1", "Status update", false), // expectsReply=false (send, not ask)
    1000,
  );

  // Cannot reply to a send message
  assert.throws(
    () => tracker.resolveReplyTarget({}, 1001),
    /No active intercom context to reply to/,
  );
});
