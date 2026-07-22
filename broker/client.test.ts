import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";

test("validated session lifecycle messages reach broker-message subscribers", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  const received: unknown[] = [];
  client.onBrokerMessage((message) => received.push(message));
  const session = {
    id: "session-2",
    cwd: "/test",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
  };

  (client as any).handleBrokerMessage({ type: "session_joined", session });
  (client as any).handleBrokerMessage({ type: "presence_update", session });
  (client as any).handleBrokerMessage({ type: "session_left", sessionId: "session-2" });

  assert.deepEqual(received, [
    { type: "session_joined", session },
    { type: "presence_update", session },
    { type: "session_left", sessionId: "session-2" },
  ]);
});

test("registered feature negotiation rejects non-string feature entries", () => {
  const client = new IntercomClient();
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "registered", sessionId: "session-1", features: ["valid", 123] }),
    /Invalid registered features/,
  );
});

test("malformed extension broker messages are rejected", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";

  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_message", namespace: "test/v1" }),
    /Invalid extension_message/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state", namespace: "test/v1", revision: -1 }),
    /Invalid extension_state/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state_result", namespace: "test/v1", committed: "yes", revision: 1 }),
    /Invalid extension_state_result/,
  );
  assert.doesNotThrow(() => (client as any).handleBrokerMessage({
    type: "extension_message",
    namespace: "test/v1",
    fromSessionId: "session-2",
    payload: { peerOnly: true },
  }));
});

test("cancelAsk ignores synchronous socket write failures", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.doesNotThrow(() => client.cancelAsk("ask-1"));
});
