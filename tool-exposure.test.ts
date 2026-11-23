import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

interface Captured {
  name: string;
  exposure?: string;
}

/** Enough of the extension API to load the extension without a session or a broker. */
function stubPi(tools: Captured[]) {
  const events = new EventEmitter();
  return {
    getSessionName: () => "exposure-test",
    setSessionName: () => undefined,
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: () => undefined,
    },
    on: () => undefined,
    registerTool: (tool: Captured) => {
      tools.push(tool);
    },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    registerMessageRenderer: () => undefined,
    registerMcpServer: () => undefined,
    appendEntry: () => undefined,
    getAllTools: () => tools,
    getActiveTools: () => tools.map((tool) => tool.name),
    setActiveTools: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    setWidget: () => undefined,
    setStatus: () => undefined,
    ui: { notify: () => undefined, setWidget: () => undefined, setStatus: () => undefined },
  };
}

/** Loads the extension against a temp config and returns the intercom tool's exposure. */
async function intercomExposure(config: Record<string, unknown> | undefined): Promise<string | undefined> {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-exposure-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    if (config !== undefined) writeFileSync(join(root, "intercom", "config.json"), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = root;
    const tools: Captured[] = [];
    const { default: piIntercomExtension } = await import("./index.ts");
    piIntercomExtension(stubPi(tools) as never);
    const matching = tools.filter((tool) => tool.name === "intercom");
    assert.equal(matching.length, 1, "the intercom tool is registered exactly once");
    return matching[0].exposure;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test("registers the intercom tool declared by default", async () => {
  assert.equal(await intercomExposure(undefined), "direct");
});

test("registers the intercom tool deferred when configured", async () => {
  assert.equal(await intercomExposure({ toolExposure: "deferred" }), "deferred");
});
