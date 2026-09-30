import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { HandoverPicker, type HandoverPickerResult, type RemoteSessionLister } from "../ui/handover-picker.ts";
import { SessionListOverlay, type SessionListSelection } from "../ui/session-list.ts";
import type { SessionInfo } from "../types.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const KEYS: Record<string, string> = {
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
  "tui.input.tab": "\t",
  "tui.editor.deleteCharBackward": "\x7f",
};
const keybindings = {
  matches: (data: string, id: string) => KEYS[id] === data,
  getKeys: (id: string) => [id.split(".").pop()!],
};

function session(id: string, name: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name, cwd: `/work/${name}`, model: "model", pid: 1, startedAt: 0, lastActivity: 0, ...extra };
}

const self = session("self-0000", "planner");
const roster = [
  self,
  session("child-0000", "subagent-worker-run-1"),
  session("unnamed-00", "subagent-chat-unnamed", { runtimeFallbackAlias: true, lastActivity: 1 }),
  session("adapter-00", "adapter", { lastActivity: 2 }),
];
const noRemote: RemoteSessionLister = {
  listMachines: async () => assert.fail("remote listing must not run on open"),
  listAgents: async () => [],
};

function open(options: { lister?: RemoteSessionLister; preselectSessionId?: string } = {}) {
  const results: Array<HandoverPickerResult | undefined> = [];
  const picker = new HandoverPicker(
    { requestRender() {} } as any,
    theme as any,
    keybindings as any,
    { currentSession: self, sessions: roster, lister: options.lister ?? noRemote, preselectSessionId: options.preselectSessionId },
    (result) => results.push(result),
  );
  const press = (...keys: string[]) => keys.forEach((key) => picker.handleInput(KEYS[key] ?? key));
  return { picker, results, press, text: () => picker.render(88).join("\n") };
}

test("handover picker lists local peers without self or subagent children", () => {
  const { text, press, results } = open();
  assert.doesNotMatch(text(), /planner|subagent-worker/);
  assert.match(text(), /adapter \(adapter-\)[\s\S]*subagent-chat-unnamed/);
  press("tui.select.confirm");
  assert.equal(results[0]?.target.kind === "local" && results[0].target.session.id, "adapter-00");
});

test("handover picker returns the next task typed in the task field", () => {
  const { press, results } = open({ preselectSessionId: "unnamed-00" });
  press("port", " the fix", "tui.select.confirm");
  assert.deepEqual(results, [{ target: { kind: "local", session: roster[2] }, goal: "port the fix" }]);
});

test("handover picker accepts pasted and Kitty-encoded next-task text", () => {
  const { press, results } = open();
  press("tui.input.tab", "\x1b[200~port the fix\x1b[201~", "\x1b[32u", "\x1b[97u", "tui.select.confirm");
  assert.equal(results[0]?.goal, "port the fix a");
});

test("session list starts a handover on plain or Kitty-encoded h and messages on Enter", () => {
  for (const [key, action] of [["h", "handover"], ["\x1b[104u", "handover"], ["\r", "message"]] as const) {
    const selections: Array<SessionListSelection | undefined> = [];
    new SessionListOverlay(theme as any, keybindings as any, self, [roster[3]!], (selection) => selections.push(selection)).handleInput(key);
    assert.deepEqual(selections, [{ session: roster[3], action }], key);
  }
});

test("handover picker fetches other machines on demand and targets a remote session by id", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const lister: RemoteSessionLister = {
    listMachines: async () => [
      { label: "workmac", target: "10.0.0.1", enabled: true },
      { label: "macmini", target: "10.0.0.2", enabled: true },
      { label: "off", target: "10.0.0.3", enabled: false },
    ],
    listAgents: async (machine) => {
      if (machine.label === "macmini") throw new Error("ssh timed out");
      return [{ name: sessionId, sessionId, cwd: "/work/remote", status: "idle" }];
    },
  };
  const { press, results, text } = open({ lister });
  press("tui.select.down", "tui.select.down", "tui.select.down", "tui.select.confirm");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(text(), /00000000@workmac · idle/);
  assert.match(text(), /macmini: ssh timed out/);
  assert.doesNotMatch(text(), /off/);
  press("tui.select.down", "tui.select.confirm");
  assert.deepEqual(results, [{ target: { kind: "remote", target: `${sessionId}@workmac` }, goal: undefined }]);
});

test("handover picker keeps the highlighted remote session when an earlier machine answers later", async () => {
  let answerSlow: (agents: Array<{ name: string }>) => void = () => {};
  const lister: RemoteSessionLister = {
    listMachines: async () => [
      { label: "slow", target: "10.0.0.1", enabled: true },
      { label: "fast", target: "10.0.0.2", enabled: true },
    ],
    listAgents: (machine) => machine.label === "fast"
      ? Promise.resolve([{ name: "fast-agent" }])
      : new Promise((resolve) => { answerSlow = resolve; }),
  };
  const { press, results } = open({ lister });
  press("tui.select.down", "tui.select.down", "tui.select.down", "tui.select.confirm");
  await new Promise((resolve) => setImmediate(resolve));
  press("tui.select.down");
  answerSlow([{ name: "slow-agent" }]);
  await new Promise((resolve) => setImmediate(resolve));
  press("tui.select.confirm");
  assert.deepEqual(results, [{ target: { kind: "remote", target: "fast-agent@fast" }, goal: undefined }]);
});

test("handover picker renders lines at the declared overlay width", () => {
  const { picker, press } = open();
  for (const focus of ["list", "task"]) {
    for (const width of [1, 2, 20, 50, 88, 120]) {
      for (const line of picker.render(width)) assert.equal(visibleWidth(line), Math.min(width, 88), `${focus} ${width}`);
    }
    press("tui.input.tab", "a long next task that does not fit in a narrow overlay");
  }
});
