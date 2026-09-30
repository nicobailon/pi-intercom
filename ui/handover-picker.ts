import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { RemoteAgent, SavedMachine } from "../cross-machine-discovery.ts";
import type { SessionInfo } from "../types.ts";
import { herdrLocationText, middleTruncate, shortSessionId } from "./session-list.ts";

const PICKER_WIDTH = 88;
const MAX_BODY_LINES = 24;
const CONTEXT_WARNING_PCT = 80;

export type HandoverPickerTarget =
  | { kind: "local"; session: SessionInfo }
  | { kind: "project" }
  | { kind: "remote"; target: string };

export interface HandoverPickerResult {
  target: HandoverPickerTarget;
  goal?: string;
}

/** Remote listing runs over SSH through Herdr, so it is injected. */
export interface RemoteSessionLister {
  listMachines(): Promise<SavedMachine[]>;
  listAgents(machine: SavedMachine): Promise<RemoteAgent[]>;
}

export interface HandoverPickerOptions {
  currentSession: SessionInfo;
  sessions: SessionInfo[];
  lister: RemoteSessionLister;
  preselectSessionId?: string;
}

type MachineEntry =
  | { machine: SavedMachine; state: "fetching" }
  | { machine: SavedMachine; state: "done"; agents: RemoteAgent[] }
  | { machine: SavedMachine; state: "error"; error: string };

type RemoteState =
  | { state: "idle" }
  | { state: "listing" }
  | { state: "error"; error: string }
  | { state: "machines"; machines: MachineEntry[] };

type Item =
  | { kind: "local"; session: SessionInfo }
  | { kind: "project" }
  | { kind: "fetch" }
  | { kind: "remote"; machine: SavedMachine; agent: RemoteAgent };

/** Subagent children register as "subagent-…"; unnamed ordinary sessions use a "subagent-chat-…" fallback alias. */
function isSubagentChild(session: SessionInfo): boolean {
  return Boolean(session.name?.startsWith("subagent-")) && session.runtimeFallbackAlias !== true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HandoverPicker implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly lister: RemoteSessionLister;
  private readonly done: (result: HandoverPickerResult | undefined) => void;
  private readonly localSessions: SessionInfo[];
  private remote: RemoteState = { state: "idle" };
  private fetchGeneration = 0;
  private closed = false;
  private selectedIndex = 0;
  private focus: "list" | "task" = "list";
  private task = "";

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: HandoverPickerOptions,
    done: (result: HandoverPickerResult | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.lister = options.lister;
    this.done = done;
    this.localSessions = options.sessions
      .filter((session) => session.id !== options.currentSession.id && !isSubagentChild(session))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const preselected = this.localSessions.findIndex((session) => session.id === options.preselectSessionId);
    if (preselected >= 0) {
      this.selectedIndex = preselected;
      this.focus = "task";
    }
  }

  private items(): Item[] {
    const items: Item[] = this.localSessions.map((session) => ({ kind: "local", session }));
    items.push({ kind: "project" }, { kind: "fetch" });
    if (this.remote.state === "machines") {
      for (const entry of this.remote.machines) {
        if (entry.state !== "done") continue;
        for (const agent of entry.agents) items.push({ kind: "remote", machine: entry.machine, agent });
      }
    }
    return items;
  }

  private close(result: HandoverPickerResult | undefined): void {
    this.closed = true;
    this.done(result);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.focus = this.focus === "list" ? "task" : "list";
      this.tui.requestRender();
      return;
    }
    const items = this.items();
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? items.length - 1 : this.selectedIndex - 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex >= items.length - 1 ? 0 : this.selectedIndex + 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = items[Math.min(this.selectedIndex, items.length - 1)];
      if (item) this.activate(item);
      return;
    }
    if (this.focus !== "task") return;
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.task = [...this.task].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }
    if (data.startsWith("\x1b")) return;
    const printable = [...data].filter((char) => char >= " ").join("");
    if (printable) {
      this.task += printable;
      this.tui.requestRender();
    }
  }

  private activate(item: Item): void {
    if (item.kind === "fetch") {
      void this.fetchRemote();
      return;
    }
    const goal = this.task.trim() || undefined;
    const target: HandoverPickerTarget = item.kind === "remote"
      ? { kind: "remote", target: `${item.agent.sessionId ?? item.agent.name}@${item.machine.label}` }
      : item;
    this.close({ target, goal });
  }

  private async fetchRemote(): Promise<void> {
    const busy = this.remote.state === "listing"
      || (this.remote.state === "machines" && this.remote.machines.some((entry) => entry.state === "fetching"));
    if (busy) return;
    const generation = ++this.fetchGeneration;
    const stale = () => this.closed || generation !== this.fetchGeneration;
    this.remote = { state: "listing" };
    this.clampSelection();
    this.tui.requestRender();

    let machines: SavedMachine[];
    try {
      machines = (await this.lister.listMachines()).filter((machine) => machine.enabled);
    } catch (error) {
      if (stale()) return;
      this.remote = { state: "error", error: errorMessage(error) };
      this.tui.requestRender();
      return;
    }
    if (stale()) return;
    const entries: MachineEntry[] = machines.map((machine) => ({ machine, state: "fetching" }));
    this.remote = { state: "machines", machines: entries };
    this.tui.requestRender();

    await Promise.all(machines.map(async (machine, index) => {
      let entry: MachineEntry;
      try {
        entry = { machine, state: "done", agents: await this.lister.listAgents(machine) };
      } catch (error) {
        entry = { machine, state: "error", error: errorMessage(error) };
      }
      if (stale()) return;
      entries[index] = entry;
      this.tui.requestRender();
    }));
  }

  private clampSelection(): void {
    this.selectedIndex = Math.min(this.selectedIndex, this.items().length - 1);
  }

  private remoteLabel(machine: SavedMachine, agent: RemoteAgent): string {
    const name = agent.sessionId && agent.name === agent.sessionId ? shortSessionId(agent.sessionId) : agent.name;
    return `${name}@${machine.label}`;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, Math.min(width, PICKER_WIDTH));
    if (innerWidth === 1) {
      return [this.theme.fg("accent", "│")];
    }

    const contentWidth = Math.max(0, innerWidth - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const separator = border(`├${"─".repeat(contentWidth)}┤`);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };
    const dim = (text: string) => this.theme.fg("dim", text);
    const pathWidth = Math.max(8, contentWidth - 4);

    const items = this.items();
    this.selectedIndex = Math.min(this.selectedIndex, items.length - 1);
    const itemIndex = new Map<Item, number>(items.map((item, index) => [item, index]));
    const body: string[] = [];
    let selectedStart = 0;
    let selectedEnd = 0;
    // `suffix` follows the title and keeps its own colors; `details` are dim secondary lines.
    const pushItem = (item: Item, title: string, details: string[] = [], suffix = "") => {
      const selected = itemIndex.get(item) === this.selectedIndex;
      if (selected) selectedStart = body.length;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      body.push(row(`${prefix}${selected ? this.theme.fg("accent", title) : title}${suffix}`), ...details.map((line) => row(`  ${dim(line)}`)));
      if (selected) selectedEnd = body.length;
    };

    body.push(row(this.theme.bold(" This machine")));
    for (const item of items) {
      if (item.kind !== "local") continue;
      const session = item.session;
      const status = session.status
        ? ` · ${session.status.split(" · ")[0] === "idle" ? dim(session.status) : this.theme.fg("warning", session.status)}`
        : "";
      const pct = typeof session.contextPct === "number"
        ? ` · ${session.contextPct >= CONTEXT_WARNING_PCT ? this.theme.fg("warning", `${session.contextPct}% ctx`) : dim(`${session.contextPct}% ctx`)}`
        : "";
      const location = herdrLocationText(session);
      pushItem(
        item,
        `${session.name || "Unnamed session"} (${shortSessionId(session.id)})`,
        [`${middleTruncate(session.cwd, pathWidth)} • ${session.model}`, ...(location ? [location] : [])],
        `${status}${pct}`,
      );
    }
    pushItem(items.find((item) => item.kind === "project")!, "+ New session in a project path…");

    body.push(separator, row(this.theme.bold(" Other machines")));
    pushItem(
      items.find((item) => item.kind === "fetch")!,
      this.remote.state === "idle" ? "Fetch sessions from other machines" : "Fetch again",
    );
    if (this.remote.state === "listing") {
      body.push(row(dim("  Listing saved Herdr machines…")));
    } else if (this.remote.state === "error") {
      body.push(row(this.theme.fg("error", `  ${this.remote.error}`)));
    } else if (this.remote.state === "machines") {
      if (this.remote.machines.length === 0) body.push(row(dim("  No enabled saved Herdr machines.")));
      for (const entry of this.remote.machines) {
        if (entry.state === "fetching") {
          body.push(row(dim(`  ${entry.machine.label}: fetching…`)));
        } else if (entry.state === "error") {
          body.push(row(this.theme.fg("error", `  ${entry.machine.label}: ${entry.error}`)));
        } else if (entry.agents.length === 0) {
          body.push(row(dim(`  ${entry.machine.label}: no Pi sessions`)));
        } else {
          for (const agent of entry.agents) {
            const item = items.find((candidate) => candidate.kind === "remote" && candidate.agent === agent)!;
            pushItem(
              item,
              this.remoteLabel(entry.machine, agent),
              agent.cwd ? [middleTruncate(agent.cwd, pathWidth)] : [],
              agent.status ? ` · ${agent.status === "idle" ? dim(agent.status) : this.theme.fg("warning", agent.status)}` : "",
            );
          }
        }
      }
    }

    let visible = body;
    if (body.length > MAX_BODY_LINES) {
      const selectedLength = selectedEnd - selectedStart;
      const start = Math.max(0, Math.min(
        selectedStart - Math.floor((MAX_BODY_LINES - 1 - selectedLength) / 2),
        body.length - (MAX_BODY_LINES - 1),
      ));
      visible = [...body.slice(start, start + MAX_BODY_LINES - 1), row(dim(` ${this.selectedIndex + 1}/${items.length}`))];
    }

    const taskLabel = " Next task (optional): ";
    const taskRoom = Math.max(1, contentWidth - visibleWidth(taskLabel) - 1);
    const taskChars = [...this.task];
    const taskText = taskChars.length > taskRoom ? `…${taskChars.slice(-(taskRoom - 1)).join("")}` : this.task;
    const taskLine = this.focus === "task" ? `${taskLabel}${taskText}█` : dim(`${taskLabel}${taskText}`);

    const keys = (id: string) => this.keybindings.getKeys(id as Parameters<KeybindingsManager["getKeys"]>[0]).join("/");
    const footer = `${keys("tui.select.confirm")}: Hand over • ${keys("tui.input.tab")}: ${this.focus === "list" ? "Next task" : "List"} • ${keys("tui.select.cancel")}: Close`;

    return [
      border(`╭${"─".repeat(contentWidth)}╮`),
      row(this.theme.bold(" Hand over to")),
      separator,
      ...visible,
      separator,
      row(taskLine),
      separator,
      row(dim(` ${footer}`)),
      border(`╰${"─".repeat(contentWidth)}╯`),
    ];
  }
}
