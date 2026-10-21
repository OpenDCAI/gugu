# Agent Runtime Read Cursor Contract

Status: accepted

This document defines the read-cursor invariant for messages delivered to long-lived
agent terminals. It exists because the read cursor is both a product signal and a
send gate: advancing it too early lets an agent reply while missing messages that
the product has already treated as read.

## Theorem

Before an agent compacts, every group message that the agent has automatically
marked read must have appeared in that agent's terminal context.

Equivalently: automatic agent read advancement is a consequence of terminal
delivery plus model turn start. It is not a consequence of room sync, background
injection, Realtime receipt, or "latest message exists".

This theorem applies to the automatic runtime path for agent-delivered messages.
Explicit operator commands such as `gugu read` are separate user actions and must
not be used as proof that the automatic agent path is safe.

## Why latest is forbidden

`UserPromptSubmit` is only evidence that the model started a new turn. It is not
evidence that every message in the chat tail has been inserted into the terminal.

Therefore this is invalid:

1. A room receives messages `m1`, `m2`, and `m3`.
2. Only `m3` is injected into the terminal.
3. `UserPromptSubmit` fires.
4. The agent read cursor jumps to the latest message (`m3`).

That would mark `m1` and `m2` read without proving they appeared in the model
context. It violates the theorem and can make `gugu send` allow a reply from stale
context.

## Required mechanism

Automatic read advancement must be exact and contiguous:

1. `agent.deliver` inserts a specific message envelope and content into the
   terminal context.
2. The runtime stores only that delivered `message_id` in the pending-delivered
   read queue. It must not store the chat's latest sequence.
3. `UserPromptSubmit` flushes the pending-delivered queue for the bound agent.
4. Each pending item calls `identity.mark_read_on_deliver(chat_id, message_id,
   agent_user_id)`.
5. `mark_read_on_deliver` may advance the cursor only if there is no earlier
   unread message from another sender between the current cursor and that exact
   message's sequence.

The SQL gap check is part of the contract, not an optimization. A later delivered
message must not jump the cursor past an earlier message that was not already
read.

## Event semantics

- `agent.deliver` delivers text and queues exact pending reads. It does not mark
  read and does not flip the agent to working.
- `UserPromptSubmit` means the provider accepted a user/model turn. It flushes
  pending delivered reads and flips the agent to working.
- `SessionStart` captures or re-confirms the terminal surface. It does not mark
  read.
- `Stop` settles work state after a turn. It does not prove new messages were
  consumed.
- `PostCompact` reminds the agent to re-read Gugu history after context loss. It
  does not itself mark read.

Claude Code and Codex must follow the same event semantics. Provider differences
belong in hook adapters, not in read-cursor rules.

## Forbidden automatic writers

No automatic path may advance an agent runtime read cursor unless it can prove the
same message was inserted into that agent's terminal context and the next
`UserPromptSubmit` occurred.

In particular, these paths must not move an agent cursor by themselves:

- room sync or Realtime delivery,
- desktop active-chat auto-read behavior,
- background terminal injection before turn start,
- compact reminders,
- presence/activity reporting,
- a blanket "mark latest read" helper.

If a future implementation needs a new automatic read writer, it must either reuse
the pending-delivered queue plus `mark_read_on_deliver` or update this document
with the equivalent proof.

## Implementation anchors

- Pending delivered queue: `packages/core/src/local/agent/deliveredReadMarkers.ts`
- Agent delivery path (ACP): `packages/core/src/local/agent/deviceCommandRuntime.ts`
- `UserPromptSubmit` flush: `packages/core/src/local/agent/freeformCapture.ts`
- Gap-safe RPC: `supabase/migrations/20260604010000_mark_read_on_deliver_identity_schema.sql`
- Send path (ACP injected MCP, 取代已删的 `apps/terminal` CLI send): `apps/desktop/electron/mcp/gugu-im-server.mjs`
