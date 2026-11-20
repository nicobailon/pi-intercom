import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkAttachmentFreshness,
  formatAttachmentFreshnessBanner,
  formatAttachmentFreshnessTag,
  formatFreshnessStatusTag,
  inspectFileSha256,
  isValidSha256Hex,
  pinFileAttachments,
} from "./attachment-freshness.ts";
import { isMessage } from "./broker/protocol.ts";
import type { Attachment } from "./types.ts";

test("pinFileAttachments pins only explicit absolute paths, preserves valid sha256, and reports honest freshness wording", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-intercom-fresh-"));
  try {
    const filePath = path.join(dir, "plan.md");
    writeFileSync(filePath, "initial\n", "utf8");

    // Display name without explicit path MUST NOT be hashed against cwd
    const unpinned = pinFileAttachments([
      { type: "file", name: "package.json", content: "unrelated\n" },
    ]);
    assert.ok(unpinned?.[0]);
    assert.equal(unpinned[0].sha256, undefined);
    assert.equal(checkAttachmentFreshness(unpinned[0]), undefined);

    // Relative explicit path is not checked or pinned
    const relPinned = pinFileAttachments([
      { type: "file", name: "plan.md", path: "plan.md", content: "initial\n" },
    ]);
    assert.equal(relPinned?.[0]?.sha256, undefined);
    assert.equal(
      checkAttachmentFreshness({
        type: "file",
        name: "plan.md",
        path: "plan.md",
        sha256: "a".repeat(64),
        content: "initial\n",
      }),
      "not_checked",
    );

    // Existing valid 64-hex sha256 is preserved without re-hashing
    const callerHash = "b".repeat(64);
    const preserved = pinFileAttachments([
      { type: "file", name: "plan.md", path: filePath, sha256: callerHash, content: "initial\n" },
    ]);
    assert.equal(preserved?.[0]?.sha256, callerHash);

    // Malformed sha256 or non-string path never throw and return "not_checked"
    assert.equal(isValidSha256Hex("deadbeef"), false);
    assert.equal(
      checkAttachmentFreshness({
        type: "file",
        name: "plan.md",
        path: filePath,
        sha256: "deadbeef",
        content: "initial\n",
      }),
      "not_checked",
    );
    const malformedAtt = {
      type: "file",
      name: "plan.md",
      path: 123,
      sha256: "a".repeat(64),
      content: "initial\n",
    } as unknown as Attachment;
    assert.equal(checkAttachmentFreshness(malformedAtt), "not_checked");

    const pinned = pinFileAttachments([
      { type: "file", name: "plan.md", path: filePath, content: "initial\n" },
    ]);
    assert.ok(pinned?.[0]?.sha256);
    assert.equal(isValidSha256Hex(pinned[0].sha256), true);
    assert.equal(checkAttachmentFreshness(pinned[0]), "unchanged");
    assert.equal(formatAttachmentFreshnessTag(pinned[0]), " (unchanged on disk since sent)");
    assert.equal(formatAttachmentFreshnessBanner(pinned), "");

    // Mixed attachments: denominator counts only pinned files (1/1, not 1/3)
    writeFileSync(filePath, "edited\n", "utf8");
    const mixed: Attachment[] = [
      pinned[0],
      { type: "snippet", name: "auth.ts", content: "const x = 1;" },
      { type: "file", name: "notes.md", content: "unpinned" },
    ];
    const mixedStatuses = mixed.map((att) => checkAttachmentFreshness(att));
    assert.equal(mixedStatuses[0], "changed");
    assert.equal(
      formatFreshnessStatusTag(mixedStatuses[0]),
      " (CHANGED on disk since sent — attachment text below is caller-supplied)",
    );
    assert.match(
      formatAttachmentFreshnessBanner(mixed, mixedStatuses),
      /1\/1 pinned file\(s\) changed\/missing\/unreadable on disk since sent/,
    );

    // Directory path is unreadable and counted in banner
    const dirAtt: Attachment = {
      type: "file",
      name: "dir",
      path: dir,
      sha256: "c".repeat(64),
      content: "",
    };
    assert.equal(checkAttachmentFreshness(dirAtt), "unreadable");
    assert.match(
      formatAttachmentFreshnessBanner([dirAtt]),
      /1\/1 pinned file\(s\) changed\/missing\/unreadable on disk since sent/,
    );

    // Bounded read returns too_large when file exceeds maxBytes
    assert.equal(inspectFileSha256(filePath, 2).status, "too_large");

    unlinkSync(filePath);
    assert.equal(checkAttachmentFreshness(pinned[0]), "missing");
    assert.equal(
      formatAttachmentFreshnessTag(pinned[0]),
      " (missing on disk since sent — attachment text below is caller-supplied)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protocol isMessage validates optional attachment path and sha256 strings", () => {
  const base = {
    id: "m-1",
    timestamp: 1000,
    content: {
      text: "hi",
      attachments: [{ type: "file", name: "a.ts", content: "x", path: "/tmp/a.ts", sha256: "a".repeat(64) }],
    },
  };
  assert.equal(isMessage(base), true);
  assert.equal(
    isMessage({
      ...base,
      content: { text: "hi", attachments: [{ type: "file", name: "a.ts", content: "x", path: 42 }] },
    }),
    false,
  );
  assert.equal(
    isMessage({
      ...base,
      content: { text: "hi", attachments: [{ type: "file", name: "a.ts", content: "x", sha256: {} }] },
    }),
    false,
  );
});
