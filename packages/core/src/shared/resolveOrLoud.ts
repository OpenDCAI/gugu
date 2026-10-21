// @@@1624 fail-loud — never mask a failed name/data resolution with a plausible generic placeholder
// ('聊天' / '未知用户' / '群聊' / '用户' / …). A silently-substituted generic name HIDES bugs: e.g. #1623 —
// an agent DM whose peer no longer resolves silently rendered '聊天', so the name was lost but looked normal.
// Instead, when a value that SHOULD resolve is missing/blank: log loudly (always — dev console + prod
// telemetry), show a glaring marker in dev so the bug is impossible to miss, and in prod fall back to a
// single configurable constant — NEVER a convincing fake name.
//
// Scope boundary (#1624): this is for DATA-layer resolution that should have produced a value. It is NOT for
// genuine empty-state/placeholder copy ('暂无会话'), user-input defaults (empty group-name → '群聊' on
// create), or explicit empty avatar state. The line is:
// data layer fails loud, rendering primitives stay graceful.

// @@@1624 - production display for an unresolved value. DECIDED by Supervisor (charter: UX calls are the
// Supervisor's, not owner-only): PROD = '' (a graceful blank — NO fake name) + the console.error below
// (so the failure still reaches logs/telemetry); DEV gets the glaring marker instead. Swapping this one
// constant changes every prod fail-loud site at once.
const PROD_UNRESOLVED_DISPLAY = ''

function isDevBuild(): boolean {
  // Source-consumed by vite (renderer) and vitest — both define import.meta.env.DEV. Node-ESM scripts have
  // import.meta but no `.env`, so this optional-chains to undefined (→ prod branch). Portable everywhere.
  return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
}

/**
 * Return `value` when it resolves to a non-blank string; otherwise FAIL LOUD: log an error (always) and
 * return a dev-visible marker (dev) or the configured prod constant (prod) — never a generic fake name.
 * `context` identifies the failed resolution in logs/markers (e.g. `dm peer name ${chatId}`).
 * `dev` overrides build-mode detection (testability seam; real callers omit it).
 */
export function resolveOrLoud(value: string | null | undefined, context: string, dev: boolean = isDevBuild()): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  // The resolution that should have produced a name/value didn't — surface it, don't paper over it.
  console.error(`[resolve-fail #1624] unresolved ${context}`)
  return dev ? `⚠未解析:${context}` : PROD_UNRESOLVED_DISPLAY
}
