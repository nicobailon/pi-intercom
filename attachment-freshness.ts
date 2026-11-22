import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Attachment } from "./types.ts";

const MAX_HASH_BYTES = 10 * 1024 * 1024;

// Reads at most the size fstat reports, so a pseudo-file that reports 0 bytes cannot stall the event loop.
function hashFile(file: string): string | undefined {
  try {
    const fd = openSync(file, "r");
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > MAX_HASH_BYTES) return undefined;
      const buffer = Buffer.allocUnsafe(stats.size);
      const bytesRead = readSync(fd, buffer, 0, stats.size, 0);
      return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function pinnedPath(attachment: Attachment): string | undefined {
  return attachment.type === "file" && isAbsolute(attachment.name) ? attachment.name : undefined;
}

export function pinFileAttachments(attachments: Attachment[] | undefined): Attachment[] | undefined {
  return attachments?.map((attachment) => {
    const file = pinnedPath(attachment);
    const sha256 = file ? hashFile(file) : undefined;
    return sha256 ? { ...attachment, sha256 } : attachment;
  });
}

export function attachmentFreshnessTag(attachment: Attachment): string {
  const file = pinnedPath(attachment);
  if (!file || !attachment.sha256) return "";
  if (!existsSync(file)) return " (no longer on disk)";
  const sha256 = hashFile(file);
  return sha256 && sha256 !== attachment.sha256 ? " (changed on disk since it was sent)" : "";
}
