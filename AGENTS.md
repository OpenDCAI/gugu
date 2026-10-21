# Gugu community development

## Source boundaries

- This monorepo owns desktop/mobile clients, the headless server, common session and assistant runtime, memory and task orchestration.
- Identity, messaging, sync, device RPC and permissions belong to the community gugu-supabase repository. Test the installed foundation rather than reading old private migration history.
- Official hosting, AgentBay lifecycle, model gateway and payment implementations belong to the personal private gugu-cloud repository. Public callers and protocols remain here; community operation must not require them.
- Internal developer plugins, official release infrastructure and private runner operations belong to the personal private gugu-dev repository. They are optional for contributors.

## Working rules

Product specifications are maintained privately by the maintainers; when a change alters user-facing behavior, describe the intended behavior in the issue or PR.

Keep the assistant runtime single-source across desktop and server. Do not replace authorization failures with successful empty responses.

Use the Node version in .node-version and the pnpm version in package.json. Follow CONTRIBUTING.md for installation and validation. Keep credentials and personal environment files outside Git.

Use a dedicated branch/worktree for substantive work and link the issue in a PR. Confirm Git identity before committing; do not append AI or Co-Authored-By signatures. Report actual validation and remaining limits.

Community development uses a dedicated user-owned Supabase project and the user's own model/CLI. Never test against official production services. Test app instances must explicitly set both GUGU_HOME and GUGU_USER_DATA_DIR to isolated paths. Preserve other running apps and sessions.

Maintain existing UI typography, colors and layout when fixing behavior. Renderer view models belong in apps/desktop, not packages/core. Public API permissions remain explicit; new backend functions start closed until a migration grants the intended role.

This checkout is an unpublished source candidate. Permission to edit or test does not authorize publication, merging, visibility changes or production deployment. License and provenance review remain publication requirements.
