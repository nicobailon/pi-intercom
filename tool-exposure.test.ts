import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.ts";

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

const CHILD_ENV = {
  PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent",
  PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "parent-session",
  PI_SUBAGENT_RUN_ID: "run-1",
  PI_SUBAGENT_CHILD_AGENT: "reviewer",
  PI_SUBAGENT_CHILD_INDEX: "1",
};

/** Loads the extension against a temp config and returns the tools it registered. */
async function registeredTools(config: Record<string, unknown> | undefined, env: Record<string, string> = {}): Promise<Captured[]> {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-exposure-"));
  const saved = new Map<string, string | undefined>();
  const remember = (key: string) => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
  };
  remember("PI_CODING_AGENT_DIR");
  for (const key of Object.keys(env)) remember(key);
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    if (config !== undefined) writeFileSync(join(root, "intercom", "config.json"), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = root;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const tools: Captured[] = [];
    const { default: piIntercomExtension } = await import("./index.ts");
    piIntercomExtension(stubPi(tools) as never);
    return tools;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function exposureOf(config: Record<string, unknown> | undefined, env: Record<string, string> = {}): Promise<string | undefined> {
  const tools = await registeredTools(config, env);
  const matching = tools.filter((tool) => tool.name === "intercom");
  assert.equal(matching.length, 1, "the intercom tool is registered exactly once");
  return matching[0].exposure;
}

test("registers the intercom tool declared by default", async () => {
  assert.equal(await exposureOf(undefined), "direct");
});

test("registers the intercom tool deferred when configured", async () => {
  assert.equal(await exposureOf({ toolExposure: "deferred" }), "deferred");
});

test("ignores the obsolete toolVisibility key next to toolExposure", async () => {
  assert.equal(await exposureOf({ toolVisibility: "after-first-use", toolExposure: "deferred" }), "deferred");
});

test("keeps the exposure when intercom is disabled", async () => {
  assert.equal(await exposureOf({ enabled: false, toolExposure: "deferred" }), "deferred");
});

test("leaves the subagent supervisor tool declared when intercom is deferred", async () => {
  const tools = await registeredTools({ toolExposure: "deferred" }, CHILD_ENV);
  const intercom = tools.find((tool) => tool.name === "intercom");
  const supervisor = tools.find((tool) => tool.name === "contact_supervisor");
  assert.ok(supervisor, "the child session registers contact_supervisor");
  assert.equal(intercom?.exposure, "deferred");
  assert.equal(supervisor.exposure, undefined, "contact_supervisor keeps the default direct exposure");
});

test("tolerates unknown config keys next to toolExposure", async () => {
  assert.equal(await exposureOf({ toolExposure: "deferred", somethingNew: true }), "deferred");
});

test("rejects invalid toolExposure values the way other keys are rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-exposure-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = root;
    for (const value of ["lazy", 5, null, true, ["deferred"]]) {
      writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ toolExposure: value }));
      assert.throws(() => loadConfig(), /"toolExposure" must be "direct" or "deferred"/, `rejects ${JSON.stringify(value)}`);
    }
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ replyHint: "yes" }));
    assert.throws(() => loadConfig(), /"replyHint" must be a boolean/, "an existing invalid key fails the same way");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
