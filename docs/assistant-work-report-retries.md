# Task report retry identity

A report is identified by the calling session and the tool invocation, rather than its text or file paths.

- Claude calls use MCP request metadata `claudecode/toolUseId`, which remains the same when that native call is replayed after reconnecting.
- Other callers use the MCP transport session and JSON-RPC request ID. Retrying that request within the same connection preserves its message and operation IDs. A new connection or host restart may produce a duplicate report; it must not suppress a new report by matching its text or file path.
- Metadata travels in the host's asynchronous invocation context, outside model arguments. Concurrent calls retain separate contexts.

After a commit acknowledgement is lost, retrying the same invocation reads its committed event and reuses the original attachment references. A different invocation with identical text and paths uploads its current files. Attachment content is compared using the attachment SHA-256, not its local path.

The current recovery lookup scans the work history for the message ID. New reports also pay this lookup cost, which grows with long task histories; indexed lookup is separate follow-up work.
