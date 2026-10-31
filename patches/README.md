# Dependency patches

`@gugu-acp__claude-agent-acp@1.4.0.patch` supplies incremental MCP string-argument previews and the explicit AIR client opt-in needed by assistant IM streaming (issue #7536). It changes the published bridge's readable distribution; the registry version and compatibility table stay pinned at 1.4.0 and 1.0.10. pnpm records the patch digest in the lockfile, so desktop and server builds install the same code without a private candidate package.

Remove this patch when a published bridge includes both changes, after verifying `acpMcpPreview7536.test.ts` and a real assistant reply from partial output through the persisted IM message. Partial previews are display data; the MCP tool still executes only after its complete input arrives.

`ssh2@1.17.0.patch` fixes how an SSH channel resumes writes that waited for the peer's window. Upstream kept the resumed stdout chunk and, once stderr also waited, wrote that old stdout chunk again instead of the stderr data. On the remote tunnel's embedded SSH server this repeated bytes inside the device link's frame stream, and the desktop dropped the link with `frame too large`. The patch clears both waiting writes before resuming them and resumes stdout and stderr. Remove it when a published ssh2 contains the same fix, after `ssh2WindowResume.test.ts` passes without it.
