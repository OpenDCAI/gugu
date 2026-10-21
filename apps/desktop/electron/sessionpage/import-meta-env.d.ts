// @@@sessionpage — minimal ambient typing for the ESM `import.meta.*` forms the session-page main process relies on,
// so the bridge + the full session-page main graph typecheck under the dedicated tsgo tsconfig without
// pulling vite/client global types. At build time esbuild statically rewrites these:
//   - `import.meta.env.*`   → a prod object (define)
//   - `import.meta.url`     → the built .cjs file URL (define + banner shim)
//   - `import.meta.glob(…)` → an inlined raw-SQL module map (migration-glob plugin)
// These declarations only satisfy the typechecker; the runtime values come from esbuild.
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
  readonly url: string
  glob(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, string>
}
