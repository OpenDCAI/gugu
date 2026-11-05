# Gugu community development

## Source boundaries

- This monorepo owns desktop/mobile clients, the headless server, common session and assistant runtime, memory and task orchestration.
- Identity, messaging, sync, device RPC and permissions belong to the community gugu-supabase repository. Test the installed foundation rather than reading old private migration history.
- Official hosting, model gateway and payment implementations are maintained privately. Public callers and protocols remain here; community operation must not require them.
- Internal developer plugins, official release infrastructure and private runner operations are maintained outside this repository. They are optional for contributors.

## Working rules

Product specifications are maintained privately by the maintainers; when a change alters user-facing behavior, describe the intended behavior in the issue or PR.

Keep the assistant runtime single-source across desktop and server. Do not replace authorization failures with successful empty responses.

Use the Node version in .node-version and the pnpm version in package.json. Follow CONTRIBUTING.md for installation and validation. Keep credentials and personal environment files outside Git.

Use a dedicated branch/worktree for substantive work and link the issue in a PR. Confirm Git identity before committing; do not append AI or Co-Authored-By signatures. Report actual validation and remaining limits.

Is a failing test yours, or a known flake? Look it up before investigating: `pnpm flake:check <test name as the runner printed it>` (or `node scripts/flake-registry.mjs <name>`); `pnpm flake:list` prints the whole registry and `pnpm flake:fields` what a lookup searches. `.github/flake-registry.json` records known flaky tests with their symptom, the tracking issue or PR, and for fixed ones the PR that fixed them. Read the status rather than treating any hit as an excuse:
- `open`: known flaky and unfixed. Not yours; cite the issue explicitly rather than silently re-running.
- `known-risk`: someone judged this site fragile and recorded why, but did not file it. Read the evidence and decide; it excuses nothing on its own.
- `fixed`: a fresh failure is a NEW defect. The entry describes the old symptom precisely so you can tell a regression from the original flake.

If you prove a failure is a pre-existing flake, add it to the registry in the same PR. A hit never makes a red check mergeable.

Community development uses a dedicated user-owned Supabase project and the user's own model/CLI. Never test against official production services. Test app instances must explicitly set both GUGU_HOME and GUGU_USER_DATA_DIR to isolated paths. Preserve other running apps and sessions.

Maintain existing UI typography, colors and layout when fixing behavior. Renderer view models belong in apps/desktop, not packages/core. Public API permissions remain explicit; new backend functions start closed until a migration grants the intended role.

Permission to edit or test does not authorize merging, releases or production deployment.

Agent approvals and questions: read `apps/desktop/electron/session/main/core/asks/index.ts` before changing any flow that waits for a person.
