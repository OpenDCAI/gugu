# Config Files And Repo Rules

## Key Files

Repo root:

- `package.json` (aggregate workspace scripts)
- `pnpm-workspace.yaml`
- `.nvmrc`
- lint/format 走仓库根:`.eslintrc.cjs` + prettier(#2802 起,原来的 oxlint/oxfmt 已删)
- `.github/workflows/`

In `apps/desktop/`:

- `package.json` (app scripts and version)
- `vite.config.mts`(仓库根,唯一一份;主进程/preload/渲染层都在这一次构建里)
- `vitest.config.ts`
- `tsconfig.json`
- `drizzle.config.ts`
- `flake.nix`

Per-project (user repos): `.gugu.json`

## Repo Rules

- avoid editing `dist/`, `release/`, and `build/` unless the task is explicitly about packaging or signing
- update the narrowest relevant page in `agents/` instead of growing `AGENTS.md`
