import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  getTsxCliPath,
  getWindowsHiddenLauncherScript,
  getWindowsBrokerCommandLine,
  getWindowsHiddenLauncherPath,
  isBrokerHealthOkMessage,
} from "./spawn.ts";

test("getTsxCliPath resolves tsx cli via module resolution", () => {
  const cliPath = getTsxCliPath("C:/repo");
  // getTsxCliPath resolves the tsx package main entry and locates cli.mjs next
  // to it, so the path reflects the real install location (bundled under
  // extensionDir or hoisted by npm) rather than a hardcoded relative path.
  assert.equal(path.basename(cliPath), "cli.mjs");
  assert.equal(path.basename(path.dirname(cliPath)), "dist");
  assert.equal(path.basename(path.dirname(path.dirname(cliPath))), "tsx");
});

test("getWindowsHiddenLauncherPath points at the broker launcher script", () => {
  const launcherPath = getWindowsHiddenLauncherPath("C:/tmp/intercom");
  assert.equal(launcherPath, path.join("C:/tmp/intercom", "broker-launch.vbs"));
});

test("getWindowsBrokerCommandLine wraps node, resolved tsx cli, and broker path", () => {
  const commandLine = getWindowsBrokerCommandLine(
    "C:/repo/broker.ts",
    "C:/repo",
    "C:/Program Files/nodejs/node.exe",
  );
  const expectedTsxPath = getTsxCliPath("C:/repo");
  assert.equal(
    commandLine,
    `"C:/Program Files/nodejs/node.exe" "${expectedTsxPath}" "C:/repo/broker.ts"`,
  );
});

test("getWindowsHiddenLauncherScript runs the broker command without showing a console", () => {
  const script = getWindowsHiddenLauncherScript('"C:/Program Files/nodejs/node.exe" "C:/repo/node_modules/tsx/dist/cli.mjs" "C:/repo/broker.ts"');
  assert.match(script, /WshShell\.Run/);
  assert.match(script, /, 0, False/);
});

test("getBrokerLaunchSpec uses wscript launcher on Windows without writing files", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/broker.ts",
      "npx",
      ["--no-install", "tsx"],
      "C:/repo",
      "win32",
      intercomDir,
      "C:/Program Files/nodejs/node.exe",
    );
    assert.equal(spec.command, "wscript.exe");
    assert.deepEqual(spec.args, [path.join(intercomDir, "broker-launch.vbs")]);
    assert.equal(spec.kind, "windows-launcher");
    const expectedTsxPath = getTsxCliPath("C:/repo");
    assert.equal(spec.launcherCommandLine, `"C:/Program Files/nodejs/node.exe" "${expectedTsxPath}" "C:/repo/broker.ts"`);
    assert.equal(existsSync(path.join(intercomDir, "broker-launch.vbs")), false);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec uses custom broker command on Windows", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));

  try {
    const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "bun", ["--smol"], "C:/repo", "win32", intercomDir, "C:/Program Files/nodejs/node.exe");
    assert.equal(spec.command, "wscript.exe");
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(spec.launcherCommandLine, `"bun" "--smol" "C:/repo/broker.ts"`);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec uses node + resolved tsx for the default non-Windows launch", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "npx", ["--no-install", "tsx"], "C:/repo", "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, [
    getTsxCliPath("C:/repo"),
    "C:/repo/broker.ts",
  ]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerLaunchSpec uses custom broker command on non-Windows", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", [], "/repo", "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerSpawnOptions hides the broker console window on Windows", () => {
  const options = getBrokerSpawnOptions("C:/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "C:/repo");
});

test("getBrokerSpawnOptions keeps portable defaults on non-Windows platforms", () => {
  const options = getBrokerSpawnOptions("/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/repo");
});

test("getBrokerSpawnOptions passes an absolute PI_CODING_AGENT_DIR to the broker", () => {
  const options = getBrokerSpawnOptions("/repo", { PI_CODING_AGENT_DIR: "relative-agent" });
  assert.equal(options.env.PI_CODING_AGENT_DIR, path.resolve("relative-agent"));
});

test("isBrokerHealthOkMessage requires the intercom protocol marker", () => {
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1", protocol: "pi-intercom", version: 1 }, "req-1"), true);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1" }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-2", protocol: "pi-intercom", version: 1 }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage("ok", "req-1"), false);
});
