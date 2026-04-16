import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getBrokerLaunchSpec, getTsxCliPath } from "./spawn.js";

test("getTsxCliPath points at local tsx cli", () => {
  const cliPath = getTsxCliPath("C:/repo");
  assert.equal(cliPath, path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs"));
});

test("getBrokerLaunchSpec uses current node executable and local tsx cli", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "C:/repo");
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [
    path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs"),
    "C:/repo/broker.ts",
  ]);
});
