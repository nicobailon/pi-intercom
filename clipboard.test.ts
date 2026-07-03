import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const { copyTextToClipboard } = await import("./index.ts");

async function readEventually(file: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out reading ${file}`);
}

test("copyTextToClipboard handles wl-copy helpers that daemonize", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-clipboard-"));
  const outFile = path.join(dir, "clipboard.txt");
  const helper = path.join(dir, "wl-copy");
  const previousPath = process.env.PATH;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousDisplay = process.env.DISPLAY;
  const previousOut = process.env.PI_INTERCOM_FAKE_CLIPBOARD_OUT;

  try {
    writeFileSync(helper, "#!/bin/sh\ncat > \"$PI_INTERCOM_FAKE_CLIPBOARD_OUT\"\n(sleep 3) &\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
    process.env.WAYLAND_DISPLAY = "wayland-test";
    delete process.env.DISPLAY;
    process.env.PI_INTERCOM_FAKE_CLIPBOARD_OUT = outFile;

    const start = Date.now();
    const result = copyTextToClipboard("handoff text");

    assert.deepEqual(result, { ok: true, method: "wl-copy" });
    assert.ok(Date.now() - start < 500, "wl-copy should not block on daemonized descendants");
    assert.equal(await readEventually(outFile), "handoff text");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (previousOut === undefined) delete process.env.PI_INTERCOM_FAKE_CLIPBOARD_OUT;
    else process.env.PI_INTERCOM_FAKE_CLIPBOARD_OUT = previousOut;
    rmSync(dir, { recursive: true, force: true });
  }
});
