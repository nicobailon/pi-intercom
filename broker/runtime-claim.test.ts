import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertNoLiveBroker } from "./runtime-claim.ts";

test("broker startup refuses to replace a live broker PID", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    assert.throws(
      () => assertNoLiveBroker(pidPath),
      new RegExp(`Refusing to replace live intercom broker process ${process.pid}`),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup tolerates absent, invalid, and stale PID files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
    writeFileSync(pidPath, "invalid\n");
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
    writeFileSync(pidPath, "2147483647\n");
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
