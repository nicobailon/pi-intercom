import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
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

test("cross-machine messages label the asserted identity as unverified", () => {
  const component = new InlineMessageComponent(from, {
    ...message,
    crossMachine: {
      type: "ssh-relay",
      version: 1,
      origin: { name: "worker", sessionId: "00000000-0000-4000-8000-000000000001", machine: "laptop" },
      trust: "ssh-asserted",
    },
  }, theme as any, 'intercom({ action: "send", to: "worker@laptop", message: "..." })');

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /worker@laptop · unverified cross-machine/);
  assert.match(rendered, /To send a new message to worker@laptop: intercom/);
  assert.doesNotMatch(rendered, /To reply/);
});

test("collapsed cross-machine messages keep the unverified identity and new-message affordance explicit", () => {
  const component = new InlineMessageComponent(from, {
    ...message,
    crossMachine: {
      type: "ssh-relay",
      version: 1,
      origin: { name: "worker", sessionId: "00000000-0000-4000-8000-000000000001", machine: "laptop" },
      trust: "ssh-asserted",
    },
  }, theme as any, 'intercom({ action: "send", to: "worker@laptop", message: "..." })', undefined, true);

  const rendered = component.render(160).join("\n");
  assert.match(rendered, /From: worker@laptop · unverified cross-machine/);
  assert.match(rendered, /To send a new message to worker@laptop: intercom/);
  assert.doesNotMatch(rendered, /To reply/);
});

test("local message header and reply affordance remain unchanged", () => {
  const component = new InlineMessageComponent(from, message, theme as any, "intercom reply");

  const rendered = component.render(100).join("\n");
  assert.match(rendered, /From: sender \(\/tmp\/project\)/);
  assert.match(rendered, /To reply: intercom reply/);
  assert.doesNotMatch(rendered, /unverified cross-machine|To send a new message to/);
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

  assert.match(lines[0], /^\u001b\[34m╭\u001b\[0m\u001b\[32m From:/);
  assert.match(rendered, /\u001b\[34m│\u001b\[0m\u001b\[33mBody copy\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m To reply: intercom reply\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m Attachment: note\.txt\u001b\[0m/);
  assert.match(rendered, /\u001b\[35m Reply to parent-m\u001b\[0m/);
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

  assert.match(rendered, /\u001b\[32m From:/);
  assert.match(rendered, /\u001b\[33mThis is a long message/);
  assert.match(rendered, /\u001b\[35m To reply:/);
  assert.ok(!calls.includes("accent"));
});

test("semantic styling remains ANSI- and Unicode-width safe", () => {
  const unicodeFrom = { ...from, name: "送信者🛰️", cwd: "/tmp/計画" };
  const unicodeMessage = {
    ...message,
    content: { text: "\u001b[36m色付き本文\u001b[0m with emoji 🧪 and a long Unicode tail 計画計画計画" },
  };
  const component = new InlineMessageComponent(unicodeFrom, unicodeMessage, styledTheme() as any, "返信");

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

  assert.match(before, /\u001b\[32m From:/);
  assert.match(after, /\u001b\[96m From:/);
  assert.match(after, /\u001b\[97mThis is a long message/);
  assert.match(after, /\u001b\[90m╭/);
  assert.notEqual(before, after);
});

const clickMessage: Message = {
  ...message,
  replyTo: "parent-message-id",
  provenance: { type: "extension_outbox", extensionId: "synthetic-extension-id", extensionName: "synthetic-extension", requestId: "synthetic-request" },
  content: {
    text: "Preview start 中文 🧪 \u001b[36mcolored\u001b[0m \u001b]8;;https://example.invalid\u0007synthetic-link\u001b]8;;\u0007 " + "wrapped body words ".repeat(16) + "EXPANDED_TAIL",
    attachments: [{ type: "snippet", name: "note.txt", content: "details" }],
  },
};

function mouseEvent(component: Component, y: number, overrides: Partial<TuiMouseEvent> = {}) {
  const height = component.render(100).length;
  return {
    type: "click", button: "left", x: 5, y, screenX: 5, screenY: y + 10,
    width: 100, height, shift: false, alt: false, ctrl: false, clickCount: 1,
    ...overrides,
  } satisfies TuiMouseEvent;
}

for (const collapsed of [true, false]) {
  test(`inline click on any ${collapsed ? "collapsed" : "expanded"} row toggles only this message`, () => {
    const rows = new InlineMessageComponent(from, clickMessage, theme as any, "intercom reply", undefined, collapsed).render(100).length;
    for (let y = 0; y < rows; y++) {
      const component: Component = new InlineMessageComponent(from, clickMessage, theme as any, "intercom reply", undefined, collapsed);
      const neighbor = new InlineMessageComponent(from, clickMessage, theme as any, "intercom reply", undefined, collapsed);
      const neighborBefore = neighbor.render(100);
      const lines = component.render(100);
      const result = component.handleMouse?.(mouseEvent(component, y));
      assert.equal(component.render(100).join("\n").includes("EXPANDED_TAIL"), collapsed, `row ${y}: single click changes visible expansion`);
      assert.deepEqual(result, { handled: true, render: true });
      assert.deepEqual(neighbor.render(100), neighborBefore);
      assert.deepEqual(component.handleMouse?.(mouseEvent(component, 0, { clickCount: undefined })), { handled: true, render: true });
      assert.deepEqual(component.render(100), lines, `row ${y}: a second deliberate single restores output`);
    }
  });
}

const ignoredMouseEvents: Array<Partial<TuiMouseEvent>> = [
  ...(["press", "release", "move", "drag", "wheel"] as const).map((type) => ({ type })),
  { type: "wheel", wheelDelta: -3 }, { type: "wheel", wheelDelta: 3 },
  { button: "right" }, { button: "middle" }, { button: "none" },
  { shift: true }, { alt: true }, { ctrl: true }, { clickCount: 2 }, { clickCount: 3 },
];

for (const collapsed of [true, false]) {
  test(`inline mouse fallback preserves ${collapsed ? "collapsed" : "expanded"} output for non-single-primary events`, () => {
    const component: Component = new InlineMessageComponent(from, clickMessage, theme as any, "intercom reply", undefined, collapsed);
    const before = component.render(100);
    for (const ignored of ignoredMouseEvents) {
      assert.equal(component.handleMouse?.(mouseEvent(component, 0, ignored)), undefined, JSON.stringify(ignored));
      assert.deepEqual(component.render(100), before);
    }
  });
}

test("inline click expands a frozen message without mutating it", () => {
  const frozen = structuredClone(clickMessage);
  Object.freeze(frozen.content.attachments![0]);
  Object.freeze(frozen.content.attachments);
  Object.freeze(frozen.content);
  Object.freeze(frozen.provenance);
  Object.freeze(frozen);
  const before = structuredClone(frozen);
  const component: Component = new InlineMessageComponent(Object.freeze({ ...from }), frozen, styledTheme() as any, "intercom reply", undefined, true);
  component.handleMouse?.(mouseEvent(component, 1));
  assert.match(component.render(100).join("\n"), /EXPANDED_TAIL/);
  assert.deepEqual(frozen, before);
});

test("inline preview and wrapped body caches avoid rereading text on repeated renders and click", () => {
  let reads = 0;
  const cachedMessage = { ...clickMessage, content: { get text() { reads++; return clickMessage.content.text; } } };
  const component: Component = new InlineMessageComponent(from, cachedMessage, theme as any, undefined, undefined, true);
  component.render(100);
  const previewReads = reads;
  component.render(100);
  component.render(80);
  assert.equal(reads, previewReads, "collapsed preview is reused across widths");
  component.handleMouse?.(mouseEvent(component, 0));
  assert.equal(reads, previewReads, "handler does not scan body text");
  assert.match(component.render(100).join("\n"), /EXPANDED_TAIL/);
  const bodyReads = reads;
  component.render(100);
  component.invalidate();
  component.render(100);
  assert.equal(reads, bodyReads, "same-width body cache survives invalidate");
  component.render(80);
  assert.ok(reads > bodyReads, "new body width rewraps the body");
});

test("collapsed inline hint retains Ctrl+O and advertises fullscreen message clicks", () => {
  const component = new InlineMessageComponent(from, clickMessage, theme as any, undefined, undefined, true);
  const output = component.render(160).join("\n");
  assert.match(output, /Ctrl\+O/);
  assert.match(output, /click.*message.*fullscreen/i);
});
