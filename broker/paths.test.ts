import test from "node:test";
import assert from "node:assert/strict";
import { getBrokerSocketPath } from "./paths.js";

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses broker.sock on non-Windows", () => {
  const socketPath = getBrokerSocketPath("linux", "/home/rcroh");
  assert.match(socketPath, /broker\.sock$/);
  assert.match(socketPath, /rcroh/);
});
