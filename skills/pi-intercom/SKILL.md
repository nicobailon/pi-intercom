---
name: pi-intercom
description: |
  Streamline session-to-session coordination with pi-intercom. Send messages,
  delegate tasks, and coordinate work across multiple pi sessions on the same
  machine. Use for planner-worker workflows, cross-session context sharing,
  and real-time collaboration between sessions.
---

# Pi Intercom Skill

Use this skill when you need to coordinate work across multiple pi sessions
running on the same machine. Pi-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/name planner    # Terminal 1
/name worker     # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (blocks until answer):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns the planner's reply as the result
```

**Worker reports completion**:
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?"
})
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" })
// → Shows all connected sessions with names, cwd, models, and status
```

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "planner", message: "Use exponential backoff starting at 100ms." })
```

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom({ action: "send", to: w, message: task })
);
```

### Pattern 5: Send with Attachments

Share code snippets, files, or context:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget | You don't need a response |
| `ask` | Blocks until reply (10 min timeout) | You need an answer to continue |
| `reply` | Responds to the active or pending inbound ask | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions | You need to discover targets |
| `status` | Returns your connection state | Troubleshooting |

## Optional: Visible Peer Sessions via cmux or tmux

If no suitable intercom-connected peer session already exists and the task benefits from a long-lived visible conversation, you may spawn a new `pi` session.

Prefer `cmux new-split right` over new surfaces or workspaces so both sessions are visible side by side.

If `cmux` is unavailable, `tmux` is an optional fallback when it is installed and relevant. Use it with a private socket so the session is isolated and observable.

Use spawned peer sessions only for:
- same-codebase worker/planner splits
- reference-codebase scouting
- long-lived visible conversations where the user benefits from watching both sides

Do not use this for unrelated repos, trivial questions, or work you can finish cleanly in the current session.

### Preferred: cmux Worker or Scout Session

Same codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/current/repo && pi\n'
```

Reference codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/reference/repo && pi\n'
```

### Optional Fallback: tmux Worker or Scout Session

Same codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-worker
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/current/repo" 'pi'
```

Reference codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-reference-auth
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/reference/repo" 'pi'
```

When you use `tmux`, tell the user how to watch it:

```bash
tmux -S "$SOCKET" attach -t "$SESSION"
```

After launch, name the new session clearly so it is easy to target:

```text
/name worker
/name reference-auth
```

Then coordinate from the current session:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Take task X. Ask if blocked."
})

intercom({
  action: "ask",
  to: "reference-auth",
  message: "How does this repo structure token refresh retries?"
})
```

### Spawn Decision Rule

Spawn a visible peer session only when all of these are true:
- no existing intercom-connected session already fits the need
- the work benefits from a long-lived visible peer session
- the peer session is either in the same codebase or in an intentional reference codebase
- `cmux` is available, or `tmux` is available as an intentional fallback

If neither `cmux` nor `tmux` is available, skip this path and use normal `intercom` workflows.

## Important Constraints

### `ask` Limitations

- **10-minute timeout**: If no reply comes within 10 minutes, the ask fails
- **One at a time**: Cannot have multiple pending asks from the same session
- **Cannot self-target**: A session cannot ask itself

```typescript
// Check if already waiting before asking
const result = await intercom({ action: "ask", to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions show a confirmation dialog
- **Replies skip confirmation**: Messages with `replyTo` never show confirmation dialogs

## Best Practices

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
const reply = await intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// Continue with the answer...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Include reply hints in messages

Make it easy for recipients to respond:

```typescript
// GOOD: Recipient sees exact command to reply
intercom({
  action: "send",
  to: "worker",
  message: `Found the issue in auth.ts:142. Use getUserById() instead of getUser().

Reply with: intercom({ action: "reply", message: "..." })`
});
```

### Name sessions meaningfully

Use `/name` so others can target you easily:

```
/name api-worker
/name frontend-dev
/name planner
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**
```typescript
// You can only have one pending ask at a time
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });

// Option 2: Wait for current ask to complete first
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```

**Ask timeout (after 10 minutes)**
```typescript
// The ask will reject with a timeout error
// Design your workflow so answers come within 10 minutes
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded pi-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

```typescript
intercom({ action: "status" })
// Check if broker is running and restart if needed
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code
intercom({
  action: "send",
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom({
  action: "ask",
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom({
  action: "reply",
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom({ action: "send", to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom({ action: "send", to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom({ action: "send", to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For tasks that might exceed 10 minutes, use send + periodic asks

// 1. Initial send with full context
intercom({
  action: "send",
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom({ action: "send", to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with decision...
```
