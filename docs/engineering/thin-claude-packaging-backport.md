# Thin Claude payloads in stable and backport builds

The Claude provider selects the host installation and passes it to the ACP bridge
as `CLAUDE_CODE_EXECUTABLE`. The bridge passes that path to the SDK as
`pathToClaudeCodeExecutable`. Keep the ACP bridge and SDK JavaScript; the SDK's
platform-native fallback executables are not the selected host installation.

The v0.3.0 packaging exclusion only matched a top-level `node_modules` package.
The ACP bridge's nested SDK version therefore carried both macOS CPU variants
into the arm64 app. Changing DMG compression or enabling asar does not address it.

## Next stable release

Promote a tested candidate that contains the recursive exclusion introduced by
`3b349a25ed19c7e58337cd6c0b292b10a0cda866` and the materialized-payload check.
Both stable and beta use the same `electron-builder.cjs` `afterPack` hook. It runs
after dependencies and extraResources are copied, before signing or archiving.
The check rejects native packages at any nesting depth in the app and legacy ACP
resource, and fails if a dependency alias escapes the verifiable package.

## 0.3.0 hotfix branch

Do not modify the existing release tag or republish its assets. From a separate
hotfix branch based on `v0.3.0`:

1. Backport the recursive exclusion from `3b349a25`: use
   `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `files` and the legacy
   ACP `extraResources` filter. Retain the JavaScript bridge and SDK. The original
   commit also removes the Claude-only legacy full-bundle selection; preserve the
   same host-CLI contract rather than creating another bundled CLI fallback.
2. Apply `scripts/checks/verify-packed-claude-payload.cjs` from this change. Its
   path works in both the older flat-script tree and the current grouped tree.
3. Require it from `electron-builder.cjs` and call
   `verifyPackedClaudePayload(path.dirname(packedAppDir(context)))` in `afterPack`
   after the bundled npm dependency copy and before its platform-specific return.
   Keep the old tree's existing `scripts/pack-npm-bundled-deps.cjs` import path;
   do not copy the current configuration wholesale over the older release.
4. Run the matcher and final-tree tests, then build a local-only arm64 package.
   Inspect the real output: no `claude-agent-sdk-*` package, while the SDK JS and
   ACP bridge remain. Measure both the `.app` and DMG; verify the selected host CLI
   still reaches the bridge in the normal functional acceptance run.

Only the release owner chooses the new hotfix version and publication window.
This change neither dispatches a release nor changes signing, feeds or backends.

## Alternatives

Keeping only the target CPU's embedded CLI avoids one wrong-architecture copy but
still adds hundreds of MB and leaves a second CLI/version beside the selected
host installation. Downloading an SDK fallback on first use saves installer bytes
but adds a new network, verification, cache and update path. Neither is needed to
preserve the current host-CLI behavior; use the existing host dependency setup.
