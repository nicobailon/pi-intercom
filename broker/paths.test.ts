import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getBrokerListenTarget,
  getBrokerPortFilePath,
  getBrokerSocketPath,
  getIntercomDirPath,
  INTERCOM_DIR_MODE,
  INTERCOM_RUNTIME_FILE_MODE,
  INTERCOM_TCP_HOST,
  restrictIntercomRuntimeFile,
  shouldUseWindowsTcpTransport,
} from "./paths.ts";

test("getAgentDirPath defaults to the pi agent directory under home", () => {
  assert.equal(getAgentDirPath({}, "/home/rcroh"), join("/home/rcroh", ".pi/agent"));
});

test("getAgentDirPath honors PI_CODING_AGENT_DIR", () => {
  assert.equal(getAgentDirPath({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, "/home/rcroh"), "/tmp/pi-agent");
});

test("getAgentDirPath resolves relative PI_CODING_AGENT_DIR values from the caller cwd", () => {
  assert.equal(
    getAgentDirPath({ PI_CODING_AGENT_DIR: "relative-agent" }, "/home/rcroh", "/workspace/project"),
    join("/workspace/project", "relative-agent"),
  );
});

test("getIntercomDirPath points at the intercom runtime directory under the agent dir", () => {
  assert.equal(getIntercomDirPath("/tmp/pi-agent"), join("/tmp/pi-agent", "intercom"));
});

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh/.pi/agent");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses broker.sock under PI_CODING_AGENT_DIR on non-Windows", () => {
  const socketPath = getBrokerSocketPath("linux", "/tmp/pi-agent");
  assert.equal(socketPath, join("/tmp/pi-agent", "intercom", "broker.sock"));
});

test("Windows TCP transport is opt-in", () => {
  assert.equal(shouldUseWindowsTcpTransport("win32", {}), false);
  assert.equal(shouldUseWindowsTcpTransport("win32", { PI_INTERCOM_TRANSPORT: "tcp" }), true);
  assert.equal(shouldUseWindowsTcpTransport("win32", { PI_INTERCOM_TCP: "1" }), true);
  assert.equal(shouldUseWindowsTcpTransport("linux", { PI_INTERCOM_TRANSPORT: "tcp" }), false);
});

test("getBrokerListenTarget uses dynamic localhost TCP only when opted in on Windows", () => {
  assert.deepEqual(getBrokerListenTarget("win32", { PI_INTERCOM_TRANSPORT: "tcp" }), {
    transport: "tcp",
    host: INTERCOM_TCP_HOST,
    port: 0,
  });
  assert.equal(getBrokerListenTarget("win32", {}), getBrokerSocketPath("win32", getAgentDirPath({})));
});

test("getBrokerConnectTarget reads opt-in Windows TCP endpoint from intercom state", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
  const intercomDir = join(root, "intercom");

  try {
    ensureIntercomRuntimeDir(intercomDir, "win32");
    writeFileSync(getBrokerPortFilePath(intercomDir), JSON.stringify({
      transport: "tcp",
      host: "127.0.0.1",
      port: 41234,
      stateId: "state-1",
    }));
    assert.deepEqual(getBrokerConnectTarget("win32", { PI_INTERCOM_TRANSPORT: "tcp" }, intercomDir), {
      transport: "tcp",
      host: "127.0.0.1",
      port: 41234,
      stateId: "state-1",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getBrokerConnectTarget rejects non-local TCP endpoint hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
  const intercomDir = join(root, "intercom");

  try {
    ensureIntercomRuntimeDir(intercomDir, "win32");
    writeFileSync(getBrokerPortFilePath(intercomDir), JSON.stringify({
      transport: "tcp",
      host: "10.0.0.5",
      port: 41234,
      stateId: "state-1",
    }));
    assert.throws(
      () => getBrokerConnectTarget("win32", { PI_INTERCOM_TRANSPORT: "tcp" }, intercomDir),
      /Invalid intercom TCP endpoint/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureIntercomRuntimeDir creates and repairs restrictive Unix directory permissions", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
  const intercomDir = join(root, "intercom");

  try {
    ensureIntercomRuntimeDir(intercomDir, "linux");
    assert.equal(statSync(intercomDir).mode & 0o777, INTERCOM_DIR_MODE);

    chmodSync(intercomDir, 0o755);
    ensureIntercomRuntimeDir(intercomDir, "linux");
    assert.equal(statSync(intercomDir).mode & 0o777, INTERCOM_DIR_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restrictIntercomRuntimeFile applies restrictive Unix file permissions", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
  const filePath = join(root, "broker.pid");

  try {
    writeFileSync(filePath, "123", { mode: 0o644 });
    restrictIntercomRuntimeFile(filePath, "linux");
    assert.equal(statSync(filePath).mode & 0o777, INTERCOM_RUNTIME_FILE_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime permission helpers skip chmod on Windows paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
  const filePath = join(root, "broker.pid");

  try {
    ensureIntercomRuntimeDir(root, "win32");
    writeFileSync(filePath, "123");
    assert.doesNotThrow(() => restrictIntercomRuntimeFile(filePath, "win32"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
