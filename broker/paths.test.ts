import test from "node:test";
import assert from "node:assert/strict";
import { getAgentDir, getBrokerSocketPath, getIntercomDir } from "./paths.js";

function withAgentDirEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.PI_CODING_AGENT_DIR;
  if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses broker.sock on non-Windows", () => {
  const socketPath = withAgentDirEnv(undefined, () => getBrokerSocketPath("linux", "/home/rcroh"));
  assert.match(socketPath, /broker\.sock$/);
  assert.match(socketPath, /rcroh/);
});

test("getAgentDir falls back to ~/.pi/agent and expands ~", () => {
  withAgentDirEnv(undefined, () => {
    assert.equal(getAgentDir("/home/rcroh"), "/home/rcroh/.pi/agent");
  });
  withAgentDirEnv("~", () => {
    assert.equal(getAgentDir("/home/rcroh"), "/home/rcroh");
  });
  withAgentDirEnv("~/relocated", () => {
    assert.equal(getAgentDir("/home/rcroh"), "/home/rcroh/relocated");
  });
  withAgentDirEnv("/abs/agent", () => {
    assert.equal(getAgentDir("/home/rcroh"), "/abs/agent");
  });
});

test("getIntercomDir and broker socket honor PI_CODING_AGENT_DIR", () => {
  withAgentDirEnv("/abs/agent", () => {
    assert.equal(getIntercomDir("/home/rcroh"), "/abs/agent/intercom");
    assert.equal(getBrokerSocketPath("linux", "/home/rcroh"), "/abs/agent/intercom/broker.sock");
  });
});
