import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { ComposeOverlay } from "../ui/compose.ts";
import { SessionListOverlay } from "../ui/session-list.ts";
import type { SessionInfo } from "../types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

const keybindings = {
  matches(): boolean {
    return false;
  },
  getKeys(id: string): string[] {
    return id.includes("confirm") ? ["enter"] : ["escape", "ctrl+c"];
  },
};

const session: SessionInfo = {
  id: "session-12345678",
  name: "subagent-chat-019ecaf6",
  cwd: "/Users/envvar/.config/ghostty",
  model: "bsy-deepseek-v4-pro",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

function assertLineWidths(label: string, lines: string[], expectedWidth: number): void {
  assert.ok(lines.length > 0, `${label} should render lines`);
  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), expectedWidth, `${label} line ${index} should match overlay width`);
  }
}

test("compose overlay renders lines at the declared overlay width", () => {
  const overlay = new ComposeOverlay(
    { requestRender() {} } as any,
    theme as any,
    keybindings as any,
    session,
    "subagent-chat-019ecaf6",
    { send: async () => ({ delivered: true, id: "message-1" }) } as any,
    () => {},
  );

  for (const width of [1, 2, 20, 40, 72]) {
    assertLineWidths("compose overlay", overlay.render(width), width);
  }
});

test("session list overlay renders lines at the declared overlay width", () => {
  const overlay = new SessionListOverlay(theme as any, keybindings as any, session, [session], () => {});

  for (const width of [1, 2, 20, 50, 88]) {
    assertLineWidths("session list overlay", overlay.render(width), width);
  }
});
