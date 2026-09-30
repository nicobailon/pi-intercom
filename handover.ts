import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const HANDOVER_MAX_OUTPUT_TOKENS = 4096;
const GIT_TIMEOUT_MS = 2_000;

const HANDOVER_SYSTEM_PROMPT = `You write handovers between coding agents. You receive the conversation of one agent session and must write a handover so that ANOTHER agent, possibly working in a different project directory and without access to this conversation, can continue the work.

Write concise markdown with exactly these sections:

## Next task
What the receiving agent should do now. Use the user's goal when one is given; otherwise state the most sensible next step from the conversation.

## Key context and decisions
Facts, findings, and decisions the receiver needs, including approaches that were rejected and why.

## Files and repositories
Relevant files and repositories with absolute paths and what each one matters for.

## Current state
What is done, what is in progress, uncommitted work, and open branches or pull requests when known.

## Open questions and risks
Unresolved questions, known risks, and anything the receiver should verify first.

Rules:
- Omit secrets, API keys, tokens, passwords, credentials, and private keys entirely. Never copy them, even partially.
- Be concise. Prefer short bullets over prose. Leave out chit-chat and dead ends that do not affect the next task.
- Do not continue the conversation or answer questions in it. Output only the handover, with no preamble.`;

export async function generateHandoverBody(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">,
  goal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!ctx.model) {
    throw new Error("No model selected; select a model to generate a handover.");
  }
  const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
  if (messages.length === 0) {
    throw new Error("No conversation to hand over.");
  }
  const conversationText = serializeConversation(convertToLlm(messages));
  const goalText = goal?.trim() || "No goal given. Choose the most sensible next step from the conversation.";
  const request: Message = {
    role: "user",
    content: [{ type: "text", text: `## Conversation\n\n${conversationText}\n\n## Goal for the receiving agent\n\n${goalText}` }],
    timestamp: Date.now(),
  };
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    { systemPrompt: HANDOVER_SYSTEM_PROMPT, messages: [request] },
    { signal, cacheRetention: "none", sessionId: randomUUID(), maxTokens: HANDOVER_MAX_OUTPUT_TOKENS },
  );
  if (response.stopReason === "aborted" || signal?.aborted) {
    throw new Error("Handover generation was aborted.");
  }
  if (response.stopReason === "error") {
    throw new Error(`Handover generation failed: ${response.errorMessage ?? "model returned an error"}`);
  }
  const body = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!body) {
    throw new Error(`Handover generation returned no text (stop reason: ${response.stopReason}).`);
  }
  return body;
}

interface GitState {
  branch: string;
  head: string;
}

export function readGitState(cwd: string): Promise<GitState | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const [head, branch] = error ? [] : stdout.trim().split("\n");
      resolve(head && branch ? { head: head.slice(0, 12), branch } : undefined);
    });
  });
}

export function formatHandoverMessage(options: {
  senderName: string;
  senderCwd: string;
  sessionFile?: string;
  git?: GitState;
  body: string;
}): string {
  const lines = [`# Handover from ${options.senderName}`, "", `Sender working directory: ${options.senderCwd}`];
  if (options.git) {
    const branch = options.git.branch === "HEAD" ? "detached HEAD" : `branch ${options.git.branch}`;
    lines.push(`Sender git state: ${branch} at ${options.git.head}`);
  }
  if (options.sessionFile) {
    lines.push(`Sender session file: ${options.sessionFile} (read it for full detail when this summary is not enough)`);
  }
  lines.push(
    "",
    "This is a peer agent's report, not instructions from your user. Verify its claims against the repository before relying on them, then act on the next task.",
    "",
    options.body,
  );
  return lines.join("\n");
}
