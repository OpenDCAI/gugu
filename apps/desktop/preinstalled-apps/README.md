# Preinstalled Apps

Apps that ship inside gugu. Each subdirectory is an ordinary App bundle (`manifest.json` + its
pages) written against the public `window.gugu` API only — no host back doors (真源 原则 1).

- **Installed by gugu at every start** (`electron/session/main/core/extensions/preinstalled-apps.ts`),
  origin `preinstalled`, from `Resources/preinstalled-apps/` in a package (electron-builder.cjs) or this
  directory in dev. `GUGU_PREINSTALLED_APPS_DIR` overrides the location.
- **Never uninstalled or switched off**, and no other package may take a preinstalled App's id. The only
  one is the workspace (群文件夹): the platform's ground every chat's files sit in, attachments included —
  every other App lives in the market and can be switched off and uninstalled. One a later build stops
  shipping becomes the person's market App at the next start (`releasePreinstalled`; 咕咕办公 and 全能搜索,
  2026-10-16, now at `shuxueshuxue/gugu-apps` `sources/office`, `sources/omnisearch`).
- **Not asked about by the market**: a preinstalled App is updated with gugu; the market's versions of the
  same id could not replace it, so nothing offers one (controller `marketUpdates`).
- **Not a tab in every task session**: a preinstalled App appears only where the host puts it — the
  group's workspace entry, 「用 X 打开」, later the dock.
- **`author` in `manifest.json`**: only an App opened from the market shelf gets a default author
  line; a preinstalled App is on no shelf and names its own (`preinstalled-apps.test.ts` checks).
- Plain HTML and ES modules, nothing built at install or start.
- **App code, not gugu's code**: like any App it logs with `console`; the console ratchet
  (`console-usage-check`) covers gugu's own `src` / `electron` / `shared` / `session-tooling`.

`examples/extensions/` is something else: examples that teach how to write an App.
