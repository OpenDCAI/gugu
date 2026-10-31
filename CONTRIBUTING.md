# Contributing to Gugu

English | [简体中文](CONTRIBUTING.zh-CN.md)

Gugu is an agent collaboration tool built for researchers and scientists. Community development uses only the documentation and scripts in this repository; no private tooling is required.

## Getting started

1. Read `AGENTS.md` at the repository root and set up the toolchain from `.node-version` and the `packageManager` field in `package.json`.
2. In a separate checkout, run `pnpm install --frozen-lockfile`, then `pnpm rebuild:native` to build native modules for Electron; configuration is described in `.envs/example.env`.
3. Use your own development backend; optional official-service settings are in `docs/optional-cloud-services.md`.
4. Start an isolated instance with `scripts/dev-app.sh`; check commands are in `docs/development-tools.md`.

Database setup and authorization follow the backend repository's documentation.

## Rules

- Issue first: open or claim an issue before you start; describe the implementation when closing it.
- Branch from the latest `origin/dev` and target `dev` in pull requests. `main` is the release channel; maintainers handle promotion.
- Merging needs passing checks and review; do not merge your own PR. The required checks are whatever the repository currently enforces.
- Use dedicated test accounts and isolated data. Never touch production, other people's instances or shared tool installations.
- Keep secrets, login sessions and private operational details out of Git, issues and chat.
- Product specifications are maintained privately by the maintainers; when a change alters user-facing behavior, describe the intended behavior in the issue or PR.
- Most code comments are in Chinese. Comments and discussions in English are welcome.

Building and integrating public Apps: see `docs/writing-a-tab-extension.md`.
