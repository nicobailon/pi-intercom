import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const cliPath = getTsxCliPath();
  // getTsxCliPath resolves the tsx package main entry and locates cli.mjs next
  // to it, so the path reflects the real install location (bundled under
  // extensionDir or hoisted by npm) rather than a hardcoded relative path.
  assert.equal(path.basename(cliPath), "cli.mjs");
  assert.equal(path.basename(path.dirname(cliPath)), "dist");
  assert.equal(path.basename(path.dirname(path.dirname(cliPath))), "tsx");
});

test("getTsxCliPath falls back to a flat sibling tsx install", () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-store-"));

  try {
    const extensionDir = path.join(storeDir, "node_modules", "pi-intercom");
    const cliPath = path.join(storeDir, "node_modules", "tsx", "dist", "cli.mjs");
    mkdirSync(extensionDir, { recursive: true });
    mkdirSync(path.dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, "");

    assert.equal(getTsxCliPath(extensionDir), cliPath);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("getTsxCliPath keeps the nested fallback when no sibling tsx cli exists", () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-store-"));

  try {
    const extensionDir = path.join(storeDir, "pi-intercom");
    mkdirSync(extensionDir, { recursive: true });

    assert.equal(
      getTsxCliPath(extensionDir),
      path.join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs"),
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
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
    assert.equal(spec.captureStartupStderr, false);
    assert.equal(existsSync(path.join(intercomDir, "broker-launch.vbs")), false);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec falls back to PATH node for a standalone Pi executable on Windows", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/broker.ts",
      "npx",
      ["--no-install", "tsx"],
      "C:/repo",
      "win32",
      intercomDir,
      "C:/Program Files/Pi/pi.exe",
    );
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(spec.launcherCommandLine, `"node" "${getTsxCliPath("C:/repo")}" "C:/repo/broker.ts"`);
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
  assert.equal(spec.captureStartupStderr, true);
});

test("getBrokerLaunchSpec falls back to PATH node for a standalone Pi executable on non-Windows", () => {
  const spec = getBrokerLaunchSpec(
    "/repo/broker.ts",
    "npx",
    ["--no-install", "tsx"],
    "/repo",
    "darwin",
    "/tmp/intercom",
    "/Applications/Pi.app/Contents/MacOS/pi",
  );
  assert.equal(spec.command, "node");
  assert.deepEqual(spec.args, [
    getTsxCliPath("/repo"),
    "/repo/broker.ts",
  ]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerLaunchSpec uses custom broker command on non-Windows", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", [], "/repo", "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
  assert.equal(spec.kind, "direct");
  assert.equal(spec.captureStartupStderr, false);
});

test("getBrokerSpawnOptions hides the broker console window on Windows", () => {
  const options = getBrokerSpawnOptions("C:/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(options.cwd, "C:/repo");
});

test("getBrokerSpawnOptions keeps portable defaults on non-Windows platforms", () => {
  const options = getBrokerSpawnOptions("/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(options.cwd, "/repo");
});

test("getBrokerSpawnOptions can keep custom broker stderr ignored", () => {
  const options = getBrokerSpawnOptions("/repo", process.env, false);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/repo");
});

test("getBrokerSpawnOptions passes an absolute PI_CODING_AGENT_DIR to the broker", () => {
  const options = getBrokerSpawnOptions("/repo", { PI_CODING_AGENT_DIR: "relative-agent" });
  assert.equal(options.env.PI_CODING_AGENT_DIR, path.resolve("relative-agent"));
});

test("spawnBrokerIfNeeded includes stderr from default broker startup failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-spawn-"));
  const extensionDir = path.join(root, "pi-intercom");
  const brokerDir = path.join(extensionDir, "broker");
  const fakeTsxCli = path.join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    mkdirSync(brokerDir, { recursive: true });
    mkdirSync(path.dirname(fakeTsxCli), { recursive: true });
    writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(fakeTsxCli, "process.stderr.write('fake tsx failed\\n'); process.exit(1);\n");

    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    for (const fileName of ["spawn.ts", "framing.ts", "paths.ts"]) {
      cpSync(path.join(sourceDir, fileName), path.join(brokerDir, fileName));
    }

    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const moduleUrl = `${pathToFileURL(path.join(brokerDir, "spawn.ts")).href}?case=${Date.now()}`;
    const imported = await import(moduleUrl) as typeof import("./spawn.ts");

    await assert.rejects(
      () => imported.spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Intercom broker exited before startup with code 1/);
        assert.match(error.message, /Broker stderr:\nfake tsx failed/);
        return true;
      },
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("isBrokerHealthOkMessage requires the intercom protocol marker", () => {
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1", protocol: "pi-intercom", version: 1 }, "req-1"), true);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1" }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-2", protocol: "pi-intercom", version: 1 }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage("ok", "req-1"), false);
});
