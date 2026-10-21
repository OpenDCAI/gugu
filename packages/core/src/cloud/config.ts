// Supabase connection is resolved from the environment first. A *shipped* build may also bake the
// PUBLIC live config (URL + anon JWT, both public) at build time so a CLI-only install can cold-start
// (gugu login) without first running the desktop — see #34 friction report (bootstrap deadlock). The
// "no hardcoded fallback" intent of #398/#399 is preserved for SOURCE/dev runs: the bake is injected
// by the build (esbuild/vite `define`), so a from-source run with no env still fails loudly rather
// than silently pointing at a wrong/stale database. Env always overrides the baked default.
//
//   - Renderer & electron-main (Vite builds): import.meta.env.VITE_SUPABASE_*
//   - Node (terminal, scripts, agent runtime): process.env.GUGU_SUPABASE_*
//     (also accepts VITE_* so a single .env.local works for node tooling too)
//   - Shipped build fallback: __GUGU_DEFAULT_SUPABASE_URL__ / __GUGU_DEFAULT_SUPABASE_ANON_KEY__
//     (build-time `define`; undefined in source → fail loud).
//
// The anon key is a public JWT; the service-role key still lives outside git.

// Build-time injected (esbuild/vite define) for shipped builds; absent in source/dev.
declare const __GUGU_DEFAULT_SUPABASE_URL__: string | undefined
declare const __GUGU_DEFAULT_SUPABASE_ANON_KEY__: string | undefined

function bakedDefault(which: 'url' | 'anon'): string | undefined {
  // typeof guards an undeclared identifier (no ReferenceError) when the build didn't define it.
  const value =
    which === 'url'
      ? typeof __GUGU_DEFAULT_SUPABASE_URL__ !== 'undefined'
        ? __GUGU_DEFAULT_SUPABASE_URL__
        : undefined
      : typeof __GUGU_DEFAULT_SUPABASE_ANON_KEY__ !== 'undefined'
        ? __GUGU_DEFAULT_SUPABASE_ANON_KEY__
        : undefined
  return value && value.length > 0 ? value : undefined
}

function readSupabaseEnv(viteKey: string, nodeKey: string): string | undefined {
  let value: string | undefined
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    if (metaEnv) value = metaEnv[viteKey]
  } catch {
    // Plain Node module evaluation: import.meta.env is absent — fall through.
  }
  if (!value && typeof process !== 'undefined' && process.env) {
    value = process.env[nodeKey] || process.env[viteKey]
  }
  return value && value.length > 0 ? value : undefined
}

export function getSupabaseUrl(): string {
  const url = readSupabaseEnv('VITE_SUPABASE_URL', 'GUGU_SUPABASE_URL') ?? bakedDefault('url')
  if (!url) {
    throw new Error(
      'Supabase URL is not configured. Set VITE_SUPABASE_URL (renderer/electron) or ' +
        'GUGU_SUPABASE_URL (node). There is no hardcoded fallback by design.'
    )
  }
  return url
}

export function getSupabaseAnonKey(): string {
  const anonKey =
    readSupabaseEnv('VITE_SUPABASE_ANON_KEY', 'GUGU_SUPABASE_ANON_KEY') ?? bakedDefault('anon')
  if (!anonKey) {
    throw new Error(
      'Supabase anon key is not configured. Set VITE_SUPABASE_ANON_KEY (renderer/electron) or ' +
        'GUGU_SUPABASE_ANON_KEY (node). There is no hardcoded fallback by design.'
    )
  }
  return anonKey
}
