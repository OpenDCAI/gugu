// @@@sessionpage — ambient declarations the session-page main graph needs to typecheck under the
// dedicated tsgo lane (a standard Electron/Vite build would get these from `vite/client` + a newer @types/electron;
// this lane deliberately uses only `types: ["node"]` + gugu's electron 28). Scoped to the
// session-page bridge tsconfig ONLY — never part of gugu's four-door program.

// electron-vite's `?asset` suffix (mirrors vite/client). At build the `?asset` esbuild plugin turns
// this into the asset's path string; here we only satisfy the typechecker.
declare module '*?asset' {
  const src: string
  export default src
}

// !!! ELECTRON-28 vs ELECTRON-40 API GAP — BOOT RISK, NOT A CODE STUB !!!
// The session backend's browser-webcontents-registry.ts calls `Session.clearData(...)`, added in Electron 37.
// gugu ships Electron 28.3.3, whose @types/electron has no `clearData`. The code BUNDLES fine
// (esbuild does not typecheck); at RUNTIME on electron 28 `session.clearData` is `undefined` and the
// browser profile-clear feature (browserController.clearData → browser data clearing) would throw.
// This narrow augmentation makes that source typecheck against the newer API it calls —
// it does NOT change behavior and does NOT hide other electron-40 gaps (any other newer API still
// errors). The runtime gap is tracked in the BOOT-lane risk checklist.
// This file is an ambient SCRIPT (no top-level import/export), so a top-level `declare namespace
// Electron` merges into electron's global `Electron` namespace, adding `clearData` to the `Session`
// class instance type (interface↔class declaration merging).
declare namespace Electron {
  interface Session {
    clearData(options?: {
      dataTypes?: string[]
      origins?: string[]
      excludeOrigins?: string[]
      avoidClosingConnections?: boolean
      originMatchingMode?: 'third-parties-included' | 'origin-scoped'
    }): Promise<void>
  }
}
