# Local password vault storage and encrypted audit

These desktop-main primitives are dormant. Nothing registers them in IPC, MCP, device actions, the server, diagnostics or transcript upload. They do not enable password saving or use. Integration must supply the real native-file boundary, permission/readiness checks, trusted local person authentication and browser coordinator; test doubles cannot supply production readiness.

## Storage and keys

Use the startup-registered `GUGU_HOME/private/password-vault/v1/` root. The host must obtain that exact root and its current protection status from the native-file exclusion registry before constructing this service. Every filesystem operation checks protection again, including before creating directories. No recovery export, backup, shared-folder copy or alternate storage location is created.

An installation manifest binds a random installation id to the host's stable local installation binding. Each account has a separate hashed directory, independent random 256-bit data key and credential file. Credential records and their management-operation ledger use Node/OpenSSL AES-256-GCM with a fresh 96-bit nonce and a 128-bit authentication tag. Authenticated context binds format, account, installation, vault and purpose. Metadata in the credential payload is encrypted too. Private audit bodies use the same data key with separate authenticated context; no audit key/unlock state is cached separately. Filesystem names, sizes and timestamps are not a tamper-proof or metadata-hiding format.

The desktop adapter wraps the data key through Electron safeStorage (macOS Keychain). Setup, unlock and recovery require local system verification before key access. The current adapter uses Touch ID and refuses operation when Touch ID, the Keychain or the real macOS Electron main process is unavailable. A cloud login or an Agent-supplied person assertion is insufficient. Integrating the trusted person context remains the host's responsibility.

Recovery setup generates 256 random bits and requires confirmation in the trusted local form. The material independently wraps the data key; it is not written to a plaintext file or exposed as an Agent operation. Recovery requires the retained encrypted installation data. Losing both material and an installation that can unlock makes old credentials unrecoverable; material cannot recreate missing data. Recovery rewraps the existing authenticated data key with the current system protector. There is no cloud recovery or cross-device importer. Missing, damaged or wrongly bound data is an explicit failure, never an empty replacement.

Writes use exclusive temporary files, file fsync, atomic rename and directory fsync, inside the protected root. Symlinked directories and symlinked/multiply-linked private files are refused. These checks supplement the independent native-file exclusion; they do not replace it or promise protection against arbitrary native programs. There is one active service/writer for a root in desktop main.

## Locking, management and trusted use

`LocalPasswordVault` has one key/lock lifecycle and an unrepeatable UUID epoch. Restart starts locked. Lock synchronously changes the epoch, removes reachable plaintext copies and zeroes mutable key/secret buffers before waiting for audit I/O or browser cleanup. `installVaultLifecycle` binds OS lock, suspend, account changes, logout and app exit when installed by the host. It never unlocks on resume.

Only a host-authenticated local person may list, set up, confirm recovery, unlock, recover, save, edit, delete, read audit or clear audit. Lists contain opaque id/version/epoch references, exact origins and a fully masked account. Save/edit/delete take a stable management operation UUID. An encrypted pending/committed ledger binds that id to its original request with keyed HMAC; lost responses, restarts and post-commit audit failures can retry the original operation without creating a second effect. A changed request cannot reuse the id.

Edits/deletion synchronously revoke the affected reference and abort its active buffers, then wait for cleanup before completion. Subsequent fresh reference checks verify account context, version and epoch; invalidation notifications are not the sole check. Locking/deletion never claims website logout.

`useCredential` accepts the browser coordinator's process-local capability and shared `CredentialUseBinding`. It claims once, checks account/installation/version/epoch/origin, obtains a reliable pre-use audit receipt and calls only the sink fixed at host construction. There is no per-call secret receiver or secret-return API. The sink must check actual fields/form/frame/origin atomically with each fill and submission, call the supplied fresh checks at both steps obtain a new pre-submission audit receipt with `prepareSubmission()` after fill, and claim the sole submission. Without that receipt the synchronous submission claim refuses, including an audit outage between fill and submit. Buffers are cleared on every result. These primitives do not implement the real browser checks or isolated-login boundaries.

`cleanup(useId)` only proves clearing and always retains the isolated login surface. A `cleaned` result cannot hand back the surface/session. Only the browser coordinator may finalize handoff after the same use's required audit is recorded, all cleanup evidence is valid and the result is not uncertain. Audit failure, possible effects and unconfirmed cleanup cannot be cleared by timeout, finally blocks or a late success. The bound private `loginSurfaceId` is never an Agent result.

JavaScript strings and OS/website copies cannot be forensically zeroed. The implementation clears mutable buffers and drops reachable feature-owned plaintext fields; it does not claim secure erasure of V8 heaps, filesystem backups or a compromised local account.

## Audit and failures

`appendAudit(event, { effectPossible })` accepts only a strict structured schema with a stable event UUID, actual actor/session, credential reference/version, exact HTTPS origin, request/use ids, action/decision/source and outcome. It accepts no arbitrary notes, password, page/form/console body, query or raw error. Repeating the same event id is idempotent; changed-event reuse is rejected. Internal management transitions use stable receipts across retries.

Records are encrypted individually and retained for 90 days by default. Only the trusted person can decrypt/read or clear them. There is no general-permission JSONL mirror and no plaintext fallback. Reliable receipts follow durable writes. Before-effect audit failure blocks the sink. After a possible effect, failure returns uncertainty with no retry and the isolated login surface retained. Lock itself cannot wait to revoke secrets because an audit write failed. Public failures carry fixed codes, never lower-layer messages/causes. The service's JSON representation contains only a generic health state; private runtime fields are not enumerable.

## Verification boundaries

The unit suites exercise real temporary filesystem persistence and OpenSSL encryption with synthetic person/key/browser authorities, including recovery/corruption, account isolation, operation/event replay, retention, lock/edit races, and before/after-effect audit failures. They are not proof of trusted person UI, native-file gateway coverage, actual HTTPS submission/login-surface isolation or external transcript/diagnostic safety. Those release paths remain disabled until integrated, tested with disposable canaries and independently reviewed.

API references: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron local system verification](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesprompttouchidreason-macos), [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
