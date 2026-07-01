import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureIntercomRuntimeDir,
  getBrokerSocketPath,
  getIntercomDirPath,
  INTERCOM_DIR_MODE,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
} from "./paths.ts";

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

test("getIntercomDirPath points at the pi intercom runtime directory", () => {
  assert.equal(getIntercomDirPath("/home/rcroh"), join("/home/rcroh", ".pi/agent/intercom"));
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
