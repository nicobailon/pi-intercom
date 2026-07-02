import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCwd, sameCwd } from "./cwd.ts";

test("sameCwd collapses a trailing slash", () => {
  assert.equal(sameCwd("/usr/local", "/usr/local/"), true);
});

test("sameCwd collapses lexical '.' and '..' segments", () => {
  assert.equal(sameCwd("/usr/local/../local/./bin", "/usr/local/bin"), true);
});

test("sameCwd treats genuinely different directories as different", () => {
  assert.equal(sameCwd("/usr/local", "/usr/lib"), false);
});

test("sameCwd collapses a symlink to its real target", () => {
  const base = mkdtempSync(join(tmpdir(), "cwd-symlink-"));
  try {
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    // Reached via the symlink vs its canonical path — must compare equal.
    assert.equal(sameCwd(link, real), true);
    // And normalizeCwd resolves the link to the real path.
    assert.equal(normalizeCwd(link), realpathSync(real));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("normalizeCwd falls back to the resolved path for a nonexistent dir", () => {
  // realpathSync throws for a missing dir; normalizeCwd must still collapse the
  // lexical variants rather than throw.
  assert.equal(normalizeCwd("/no/such/dir/../dir"), "/no/such/dir");
});
