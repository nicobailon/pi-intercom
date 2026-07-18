import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { InlineMessageComponent } from "../ui/inline-message.ts";
import type { Message, SessionInfo } from "../types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
};

const from: SessionInfo = {
  id: "session-12345678",
  name: "sender",
  cwd: "/tmp/project",
  model: "model",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

const message: Message = {
  id: "message-1",
  timestamp: 0,
  content: {
    text: "This is a long message that should use the available terminal width instead of a narrow fixed card.",
  },
};

test("inline intercom messages render at the available terminal width", () => {
  const component = new InlineMessageComponent(from, message, theme as any);

  const lines = component.render(120);

  assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("expanded inline intercom messages show the full body without collapse controls", () => {
  const component = new InlineMessageComponent(from, message, theme as any, "intercom({ action: \"reply\", message: \"...\" })");

  const rendered = component.render(100).join("\n");

  assert.match(rendered, /available terminal width/);
  assert.match(rendered, /narrow fixed/);
  assert.match(rendered, /card/);
  assert.match(rendered, /To reply: intercom/);
  assert.doesNotMatch(rendered, /Ctrl\+O/);
});

test("collapsed inline intercom messages keep preview, reply hint, and expand key visible", () => {
  const component = new InlineMessageComponent(
    from,
    {
      ...message,
      content: {
        text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. This tail should only appear when expanded because the collapsed preview is intentionally brief.",
        attachments: [{ type: "snippet", name: "note.txt", content: "important details" }],
      },
    },
    theme as any,
    "intercom({ action: \"reply\", message: \"...\" })",
    undefined,
    true,
  );

  const lines = component.render(120);
  const rendered = lines.join("\n");

  assert.equal(lines.length, 4);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
  assert.match(rendered, /Alpha beta gamma/);
  assert.doesNotMatch(rendered, /intentionally brief/);
  assert.match(rendered, /To reply: intercom/);
  assert.match(rendered, /Ctrl\+O/);
  assert.match(rendered, /1 attachment/);
});

const roleCodes = {
  accent: 31,
  toolTitle: 32,
  text: 33,
  muted: 34,
  dim: 35,
} as const;

function styledTheme(calls: string[] = []) {
  return {
    fg(name: keyof typeof roleCodes, text: string): string {
      calls.push(name);
      return `\u001b[${roleCodes[name]}m${text}\u001b[0m`;
    },
  };
}

test("inline message colors follow the tool-title, text, muted-border, and dim-metadata hierarchy", () => {
  const calls: string[] = [];
  const component = new InlineMessageComponent(
    from,
    {
      ...message,
      replyTo: "parent-message-id",
      content: {
        text: "Body copy",
        attachments: [{ type: "snippet", name: "note.txt", content: "details" }],
      },
    },
    styledTheme(calls) as any,
    "intercom reply",
  );

  const lines = component.render(72);
  const rendered = lines.join("\n");

  assert.match(lines[0], /^\u001b\[34m╭\u001b\[0m\u001b\[32m 📨 From:/);
  assert.match(rendered, /\u001b\[34m│\u001b\[0m\u001b\[33mBody copy\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m ↩ To reply: intercom reply\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m 📎 note\.txt\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m ↳ Reply to parent-m\u001b\[0m/);
  assert.match(lines.at(-1)!, /^\u001b\[34m╰─+╯\u001b\[0m$/);
  assert.ok(calls.includes("toolTitle"));
  assert.ok(calls.includes("text"));
  assert.ok(calls.includes("muted"));
  assert.ok(calls.includes("dim"));
  assert.ok(!calls.includes("accent"));
});

test("collapsed inline messages preserve the same hierarchy without accent", () => {
  const calls: string[] = [];
  const component = new InlineMessageComponent(from, message, styledTheme(calls) as any, "intercom reply", undefined, true);

  const rendered = component.render(72).join("\n");

  assert.match(rendered, /\u001b\[32m 📨 From:/);
  assert.match(rendered, /\u001b\[33mThis is a long message/);
  assert.match(rendered, /\u001b\[35m ↩ To reply:/);
  assert.ok(!calls.includes("accent"));
});

test("semantic styling remains ANSI- and Unicode-width safe", () => {
  const unicodeFrom = { ...from, name: "送信者🛰️", cwd: "/tmp/計画" };
  const unicodeMessage = {
    ...message,
    content: { text: "\u001b[36m色付き本文\u001b[0m with emoji 🧪 and a long Unicode tail 計画計画計画" },
  };
  const component = new InlineMessageComponent(unicodeFrom, unicodeMessage, styledTheme() as any, "返信 📨");

  for (const width of [18, 31, 52]) {
    const lines = component.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(visibleWidth(line), width, `${width}: ${stripVTControlCharacters(line)}`);
    }
  }
});

test("inline messages pick up mutable theme proxy changes on rerender", () => {
  const palette: Record<string, number> = { ...roleCodes };
  const mutableTheme = new Proxy(
    {},
    {
      get(_target, property) {
        if (property !== "fg") return undefined;
        return (name: string, text: string) => `\u001b[${palette[name]}m${text}\u001b[0m`;
      },
    },
  );
  const component = new InlineMessageComponent(from, message, mutableTheme as any);

  const before = component.render(72).join("\n");
  palette.toolTitle = 96;
  palette.text = 97;
  palette.muted = 90;
  const after = component.render(72).join("\n");

  assert.match(before, /\u001b\[32m 📨 From:/);
  assert.match(after, /\u001b\[96m 📨 From:/);
  assert.match(after, /\u001b\[97mThis is a long message/);
  assert.match(after, /\u001b\[90m╭/);
  assert.notEqual(before, after);
});
