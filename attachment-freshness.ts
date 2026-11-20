import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { Attachment } from "./types.ts";

export const MAX_HASH_BYTES = 10 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const READ_CHUNK_BYTES = 65_536;

export type FileFreshnessStatus =
  | "unchanged"
  | "changed"
  | "missing"
  | "unreadable"
  | "too_large"
  | "not_checked";

export function isValidSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * Bounded chunked fd read stopping at maxBytes + 1 so pseudo-files
 * (e.g. /proc/self/pagemap reporting st_size=0) cannot hang the event loop.
 */
export function inspectFileSha256(
  filePath: unknown,
  maxBytes = MAX_HASH_BYTES,
): {
  status: Exclude<FileFreshnessStatus, "changed">;
  sha256?: string;
} {
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) {
    return { status: "not_checked" };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { status: code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (!stats.isFile()) {
    return { status: "unreadable" };
  }
  if (stats.size > maxBytes) {
    return { status: "too_large" };
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    while (true) {
      const toRead = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      const bytesRead = readSync(fd, buf, 0, toRead, null);
      if (bytesRead <= 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        return { status: "too_large" };
      }
      hash.update(buf.subarray(0, bytesRead));
    }
    return { status: "unchanged", sha256: hash.digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { status: code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

export function computeFileSha256(filePath: string): string | undefined {
  return inspectFileSha256(filePath).sha256;
}

/** Pin only explicit absolute paths — never interpret display att.name as a local path. */
export function pinFileAttachments(attachments: Attachment[] | undefined): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return attachments;
  }
  return attachments.map((att) => {
    if (att.type !== "file" || isValidSha256Hex(att.sha256) || typeof att.path !== "string" || !att.path) {
      return att;
    }
    const sha256 = computeFileSha256(att.path);
    if (!sha256) {
      return att;
    }
    return { ...att, sha256 };
  });
}

export function checkAttachmentFreshness(att: Attachment): FileFreshnessStatus | undefined {
  if (att.type !== "file" || att.sha256 === undefined) {
    return undefined;
  }
  if (!isValidSha256Hex(att.sha256)) {
    return "not_checked";
  }
  if (typeof att.path !== "string" || !path.isAbsolute(att.path)) {
    return "not_checked";
  }
  const inspected = inspectFileSha256(att.path);
  if (!inspected.sha256) {
    return inspected.status;
  }
  return inspected.sha256 === att.sha256.toLowerCase() ? "unchanged" : "changed";
}

export function formatFreshnessStatusTag(status: FileFreshnessStatus | undefined): string {
  if (!status) {
    return "";
  }
  if (status === "unchanged") {
    return " (unchanged on disk since sent)";
  }
  if (status === "changed") {
    return " (CHANGED on disk since sent — attachment text below is caller-supplied)";
  }
  if (status === "missing") {
    return " (missing on disk since sent — attachment text below is caller-supplied)";
  }
  if (status === "too_large") {
    return " (too large — not checked)";
  }
  if (status === "unreadable") {
    return " (unreadable — not verified)";
  }
  return " (not checked)";
}

export function formatAttachmentFreshnessTag(att: Attachment): string {
  return formatFreshnessStatusTag(checkAttachmentFreshness(att));
}

export function formatAttachmentFreshnessBanner(
  attachments: Attachment[] | undefined,
  statuses?: ReadonlyArray<FileFreshnessStatus | undefined>,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const resolved = statuses ?? attachments.map((att) => checkAttachmentFreshness(att));
  const pinnedCount = resolved.filter((st) => st !== undefined && st !== "not_checked").length;
  const flaggedCount = resolved.filter(
    (st) => st === "changed" || st === "missing" || st === "unreadable",
  ).length;
  if (flaggedCount === 0) {
    return "";
  }
  const denom = pinnedCount > 0 ? pinnedCount : flaggedCount;
  return `\n\nWARNING: ${flaggedCount}/${denom} pinned file(s) changed/missing/unreadable on disk since sent (attachment text below is caller-supplied).`;
}
