import test from "node:test";
import assert from "node:assert/strict";
import { explicitCrossMachineSendRestriction } from "./index.ts";

test("explicit cross-machine sends reject unsupported semantics before transport", () => {
  const unsupported = [
    { attachments: [{}] },
    { replyTo: "message-1" },
    { supersedes: "message-1" },
    { retryOf: "message-1" },
    { cwd: "." },
    { openProjectPaneIfMissing: true },
    { noWake: true },
  ];
  for (const extra of unsupported) {
    assert.match(
      explicitCrossMachineSendRestriction({ to: "reviewer@workstation", ...extra }) ?? "",
      /does not support|only supports/,
    );
  }
});

test("new text sends and local targets are not restricted", () => {
  assert.equal(explicitCrossMachineSendRestriction({ to: "reviewer@workstation" }), undefined);
  assert.equal(explicitCrossMachineSendRestriction({ to: "reviewer", attachments: [{}] }), undefined);
});
