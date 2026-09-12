#!/usr/bin/env -S npx tsx
/**
 * Minimal CLI for scripted access to the local pi-intercom broker.
 *
 * Commands:
 *   pi-intercom cli.ts list [--json]
 *   pi-intercom cli.ts send --to <name|session-id> --text "..." [--name <bridge-name>] [--json]
 *   pi-intercom cli.ts ask  --to <name|session-id> --text "..." [--timeout-ms N] [--name <bridge-name>] [--json]
 *
 * The CLI registers as a regular session, so it shows up in the roster and
 * replies can be routed back to it while it stays connected (`ask`).
 *
 * Exit codes: 0 ok | 1 usage, connection, or delivery failure | 2 ask timeout.
 *
 * Because it talks to the same-machine broker only, it can also be run over
 * ssh on a remote machine to bridge coordination without opening any network
 * listener:
 *
 *   ssh myserver 'tsx ~/.pi/agent/npm/node_modules/pi-intercom/cli.ts list'
 */

import { pathToFileURL } from "node:url";
import { IntercomClient } from "./broker/client.ts";
import type { Message, SessionInfo, SessionRegistration } from "./types.ts";

export const CLI_USAGE = `usage: cli.ts <list|send|ask> [--to <name|session-id>] [--text <message>]
                        [--timeout-ms <n>] [--name <session-name>] [--json]`;

export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export interface CliOptions {
  command: "list" | "send" | "ask";
  to: string | null;
  text: string | null;
  timeoutMs: number;
  name: string;
  json: boolean;
}

export class CliUsageError extends Error {}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    command: null as unknown as CliOptions["command"],
    to: null,
    text: null,
    timeoutMs: DEFAULT_ASK_TIMEOUT_MS,
    name: "pi-intercom-cli",
    json: false,
  };

  const [command, ...rest] = argv;
  if (command !== "list" && command !== "send" && command !== "ask") {
    throw new CliUsageError(`unknown command: ${String(command)}\n${CLI_USAGE}`);
  }
  opts.command = command;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) {
      throw new CliUsageError(`missing value for ${arg}\n${CLI_USAGE}`);
    }
    if (arg === "--to") {
      opts.to = value;
    } else if (arg === "--text") {
      opts.text = value;
    } else if (arg === "--name") {
      opts.name = value;
    } else if (arg === "--timeout-ms") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError(`invalid --timeout-ms value: ${value}`);
      }
      opts.timeoutMs = parsed;
    } else {
      throw new CliUsageError(`unknown option: ${arg}\n${CLI_USAGE}`);
    }
    i++;
  }

  if (opts.command !== "list") {
    if (!opts.to) {
      throw new CliUsageError(`--to is required for ${opts.command}\n${CLI_USAGE}`);
    }
    if (!opts.text) {
      throw new CliUsageError(`--text is required for ${opts.command}\n${CLI_USAGE}`);
    }
  }

  return opts;
}

/** The part of IntercomClient the CLI uses; injectable for tests. */
export interface CliClient {
  connect(session: SessionRegistration, sessionId?: string): Promise<void>;
  listSessions(options?: { timeoutMs?: number }): Promise<SessionInfo[]>;
  send(to: string, options: { text: string; expectsReply?: boolean }): Promise<{ id: string; delivered: boolean; reason?: string }>;
  on(event: "message", listener: (from: SessionInfo, message: Message) => void): unknown;
  disconnect(): Promise<void>;
}

export interface CliDeps {
  client: CliClient;
  out?: { write(chunk: string): unknown };
  err?: { write(chunk: string): unknown };
}

export function buildCliRegistration(name: string, now = Date.now()): SessionRegistration {
  return {
    cwd: process.cwd(),
    model: "pi-intercom-cli",
    pid: process.pid,
    startedAt: now,
    lastActivity: now,
    name,
    status: "idle",
  };
}

function sessionRow(session: SessionInfo): { name: string; id: string; model: string; status: string; cwd: string } {
  return {
    name: session.name ?? "(unnamed)",
    id: session.id,
    model: session.model,
    status: session.status ?? "?",
    cwd: session.cwd,
  };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (error) {
    deps.err?.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  try {
    await deps.client.connect(buildCliRegistration(opts.name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err.write(`cannot reach the local intercom broker: ${message}\n`);
    err.write("is a pi session with pi-intercom loaded currently running on this machine?\n");
    return 1;
  }

  try {
    if (opts.command === "list") {
      const sessions = await deps.client.listSessions();
      if (opts.json) {
        out.write(`${JSON.stringify(sessions.map(sessionRow), null, 2)}\n`);
      } else {
        for (const session of sessions) {
          const row = sessionRow(session);
          out.write(`${row.name}\t${row.id.slice(0, 8)}\t${row.model}\t${row.status}\t${row.cwd}\n`);
        }
      }
      return 0;
    }

    if (opts.command === "send") {
      const result = await deps.client.send(opts.to as string, { text: opts.text as string });
      if (!result.delivered) {
        if (opts.json) {
          out.write(`${JSON.stringify({ ok: false, delivered: false, reason: result.reason }, null, 2)}\n`);
        } else {
          err.write(`delivery failed: ${result.reason ?? "unknown reason"}\n`);
        }
        return 1;
      }
      if (opts.json) {
        out.write(`${JSON.stringify({ ok: true, delivered: true, id: result.id }, null, 2)}\n`);
      } else {
        out.write(`delivered to ${opts.to} (${result.id})\n`);
      }
      return 0;
    }

    // ask: resolve on the first reply-tagged inbound message. A one-shot CLI
    // process sends exactly one ask, so any replyTo-tagged message routed to
    // this connection is the reply we are waiting for.
    type AskOutcome =
      | { kind: "timeout" }
      | { kind: "delivery-failure"; reason: string }
      | { kind: "reply"; from: SessionInfo; text: string };
    let settled = false;
    const reply = await new Promise<AskOutcome>((resolve) => {
      const settle = (outcome: AskOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), opts.timeoutMs);

      deps.client.on("message", (from, message) => {
        if (message.replyTo !== undefined) {
          settle({ kind: "reply", from, text: message.content.text });
        }
      });

      deps.client.send(opts.to as string, { text: opts.text as string, expectsReply: true }).then(
        (result) => {
          if (!result.delivered) {
            settle({ kind: "delivery-failure", reason: result.reason ?? "unknown reason" });
          }
        },
        (error: unknown) => {
          settle({ kind: "delivery-failure", reason: error instanceof Error ? error.message : String(error) });
        },
      );
    });

    if (reply.kind === "timeout") {
      err.write(`ask timed out after ${opts.timeoutMs} ms waiting for a reply from ${opts.to}\n`);
      return 2;
    }
    if (reply.kind === "delivery-failure") {
      if (opts.json) {
        out.write(`${JSON.stringify({ ok: false, delivered: false, reason: reply.reason }, null, 2)}\n`);
      } else {
        err.write(`delivery failed: ${reply.reason}\n`);
      }
      return 1;
    }
    if (opts.json) {
      out.write(`${JSON.stringify({ ok: true, from: reply.from.name ?? reply.from.id, text: reply.text }, null, 2)}\n`);
    } else {
      out.write(`${reply.text}\n`);
    }
    return 0;
  } finally {
    await deps.client.disconnect().catch(() => {});
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const code = await runCli(process.argv.slice(2), { client: new IntercomClient() });
  process.exit(code);
}
