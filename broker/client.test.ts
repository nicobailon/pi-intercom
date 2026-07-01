import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";

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
