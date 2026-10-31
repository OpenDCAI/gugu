# Native Claude Code fork records

Captured with Claude Code 2.1.301 in an empty temporary directory on 2026-10-31,
using throwaway prompts only:

1. Ask for `parent one`.
2. Resume the parent and ask for `parent two`.
3. Resume with `--fork-session` and ask for `fork child`.
4. Resume the original parent and ask for `parent three`.

These are projections of the real JSONL records, not generated lineage. They keep
the original UUID-bearing rows in order, with their `type`, `subtype`, `uuid`,
`parentUuid`, `sessionId`, `isSidechain` and `timestamp` fields when present.
User/assistant messages retain their original `role`, `id`, `content`,
`stop_reason`, `usage` and `model` fields when present. Irrelevant metadata, filesystem paths and
attachment payloads are omitted. Attachment lineage nodes remain in the chain.
No UUID, timestamp, prompt, reply or completion field was added or rewritten.

The child copies the common UUID chain while rewriting its session ID. Its first
new user row points to the last common assistant row. The parent then continues
on a different branch. Assistant `stop_reason: "end_turn"` values come from the
original record. These excerpts use the corrected v2 capture; the earlier
redaction accidentally omitted those fields and is not used here.
