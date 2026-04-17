import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  getTsxCliPath,
  getWindowsBrokerCommandLine,
  getWindowsHiddenLauncherPath,
} from "./spawn.js";

test("getTsxCliPath points at local tsx cli", () => {
  const cliPath = getTsxCliPath("C:/repo");
  assert.equal(cliPath, path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs"));
});

test("getWindowsHiddenLauncherPath points at the broker launcher script", () => {
  const launcherPath = getWindowsHiddenLauncherPath("C:/tmp/intercom");
  assert.equal(launcherPath, path.join("C:/tmp/intercom", "broker-launch.vbs"));
});

test("getWindowsBrokerCommandLine wraps node, tsx cli, and broker path", () => {
  const commandLine = getWindowsBrokerCommandLine(
    "C:/repo/broker.ts",
    "C:/repo",
    "C:/Program Files/nodejs/node.exe",
  );
  assert.equal(
    commandLine,
    `"C:/Program Files/nodejs/node.exe" "${path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs")}" "C:/repo/broker.ts"`,
  );
});

test("getBrokerLaunchSpec uses wscript launcher on Windows", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "C:/repo", "win32", "C:/tmp/intercom", "C:/Program Files/nodejs/node.exe");
  assert.equal(spec.command, "wscript.exe");
  assert.deepEqual(spec.args, [path.join("C:/tmp/intercom", "broker-launch.vbs")]);
});

test("getBrokerLaunchSpec uses current node executable and local tsx cli on non-Windows", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "C:/repo", "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, [
    path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs"),
    "C:/repo/broker.ts",
  ]);
});

test("getBrokerSpawnOptions hides the broker console window on Windows", () => {
  const options = getBrokerSpawnOptions("C:/repo", "win32");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "C:/repo");
});

test("getBrokerSpawnOptions keeps portable defaults on non-Windows platforms", () => {
  const options = getBrokerSpawnOptions("/repo", "linux");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/repo");
});
