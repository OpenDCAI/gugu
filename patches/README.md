# Dependency patches

`@gugu-acp__claude-agent-acp@1.4.0.patch` supplies incremental MCP string-argument previews and the explicit AIR client opt-in needed by assistant IM streaming (issue #7536). It changes the published bridge's readable distribution; the registry version and compatibility table stay pinned at 1.4.0 and 1.0.10. pnpm records the patch digest in the lockfile, so desktop and server builds install the same code without a private candidate package.

Remove this patch when a published bridge includes both changes, after verifying `acpMcpPreview7536.test.ts` and a real assistant reply from partial output through the persisted IM message. Partial previews are display data; the MCP tool still executes only after its complete input arrives.
