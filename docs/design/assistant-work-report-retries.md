# Task report retry identity

A report is identified by the calling session and the tool invocation, rather than its text or file paths.

- Claude calls use MCP request metadata `claudecode/toolUseId`, which remains the same when that native call is replayed after reconnecting.
- Other callers use the MCP transport session and JSON-RPC request ID. Retrying that request within the same connection preserves its message and operation IDs. A new connection or host restart may produce a duplicate report; it must not suppress a new report by matching its text or file path.
- Metadata travels in the host's asynchronous invocation context, outside model arguments. Concurrent calls retain separate contexts.

After a commit acknowledgement is lost, retrying the same invocation reads its committed event and reuses the original attachment references. A different invocation with identical text and paths uploads its current files. Attachment content is compared using the attachment SHA-256, not its local path.

The current recovery lookup scans the work history for the message ID. New reports also pay this lookup cost, which grows with long task histories; indexed lookup is separate follow-up work.

## Queue availability warning

If a queue claim fails, desktop and phone attempt a plain-text warning in the assistant's owner DM through existing chat RPCs. The warning contains no raw backend error, session identifiers or task outcome claims. It does not contact or wake a task host.

The warning has one deterministic message ID per account, assistant, queue protocol version and the failure's start date in Beijing time. Same-day device races, retries and restarts reuse that message; a new outage on a later day can post a new warning. Within one process an ongoing failure retains its start date until a successful claim. A visible message row must confirm delivery. If chat is also unavailable, the next host cycle retries the same warning. A stopped host, changed account or eight-second deadline cancels the notification attempt without preventing later queue retries.
