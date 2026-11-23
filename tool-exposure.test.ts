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

async function registeredToolExposure(config: Record<string, unknown>): Promise<{ exposure?: string; registered: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-exposure-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = root;
    const tools: Captured[] = [];
    const { default: piIntercomExtension } = await import("./index.ts");
    piIntercomExtension(stubPi(tools) as never);
    const tool = tools.find((candidate) => candidate.name === "intercom");
    return { exposure: tool?.exposure, registered: tool !== undefined };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test("registers the intercom tool declared by default", async () => {
  const result = await registeredToolExposure({});
  assert.equal(result.registered, true);
  assert.equal(result.exposure, "direct");
});

test("registers the intercom tool deferred when configured", async () => {
  const result = await registeredToolExposure({ toolExposure: "deferred" });
  assert.equal(result.registered, true, "deferred still registers the tool for codemode scripts");
  assert.equal(result.exposure, "deferred");
});
