// Codex's model metadata for Gugu platform models — rendered from the gateway model directory.
//
// Codex sizes context, compaction and reasoning from a per-model descriptor looked up by slug.
// A gateway alias (`glm-5.3`, …) has no entry in its bundled catalog, so codex builds a fallback
// descriptor for it: `max_context_window` 272000 (an explicit `model_context_window=1000000` is
// clamped down to it), no reasoning levels (the picker offers none, a model switch drops the
// effort), and a per-turn "Model metadata … not found" warning.
//
// The host hands every app-server launcher the session's platform model facts in
// GUGU_PLATFORM_MODELS (id / displayName / contextWindow / efforts, all from the gateway
// directory). The launcher renders them into a `model_catalog_json` file it owns for the
// lifetime of the app-server. That file REPLACES codex's bundled catalog, so:
//  · a platform model codex already knows (same longest-prefix lookup codex does, e.g. `gpt-5.5`)
//    keeps codex's own entry — prompt, tools, effort ladder — exactly as before; only its slug is
//    the platform id. The launcher asks the installed codex for that catalog
//    (`codex debug models --bundled`, codex ≥ 0.122), so the entry always matches the binary.
//  · a model codex has no metadata for gets the gateway's facts over codex's own fallback
//    descriptor (`model_info_from_slug`, rust-v0.147.0…v0.153.4): the only behaviour that
//    changes is the part the gateway actually declares.
import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_GENERIC_BASE_INSTRUCTIONS } from './codex-generic-base-instructions.mjs'

export const PLATFORM_MODELS_ENV = 'GUGU_PLATFORM_MODELS'

/**
 * codex's own window for a model it knows nothing about (`model_info_from_slug`: context_window =
 * max_context_window = 272000). A platform model whose directory row carries no window gets exactly
 * this — the same "undeclared → codex's own default" rule as every other field — and the launcher
 * names it in its log. ❌ Omitting the window instead would leave codex with no window at all:
 * no auto-compaction, and the session overflows at the gateway.
 */
export const CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW = 272_000

function fail(message) {
  throw new Error(`${PLATFORM_MODELS_ENV}: ${message}`)
}

/** Parse and validate the facts payload; `contextWindow` is null when the directory row has none. */
export function platformModelFacts(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`not JSON (${error?.message ?? error})`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('must be a non-empty array')
  const seen = new Set()
  return parsed.map((entry, index) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id) fail(`entry ${index} has no id`)
    if (seen.has(id)) fail(`duplicate id '${id}'`)
    seen.add(id)
    const contextWindow = entry.contextWindow ?? null
    if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
      fail(`'${id}' has an invalid contextWindow ${JSON.stringify(contextWindow)}`)
    }
    // `[]` is a real answer: the directory says this model has no effort axis (or has not learned it
    // yet, #6447), so codex offers none — its own behaviour for a model it knows nothing about.
    // Absent or malformed is a broken payload, not "no efforts".
    if (!Array.isArray(entry.efforts)
      || entry.efforts.some((effort) => typeof effort !== 'string' || !effort.trim())) {
      fail(`'${id}' has malformed reasoning efforts ${JSON.stringify(entry.efforts)}`)
    }
    const displayName = typeof entry.displayName === 'string' && entry.displayName.trim()
      ? entry.displayName.trim()
      : id
    return { id, displayName, contextWindow, efforts: entry.efforts.map((effort) => effort.trim()) }
  })
}

/** codex's own lookup: the bundled entry whose slug is the longest prefix of the requested id. */
export function bundledEntryFor(id, bundled) {
  let best = null
  for (const entry of bundled) {
    if (typeof entry?.slug !== 'string' || !id.startsWith(entry.slug)) continue
    if (!best || entry.slug.length > best.slug.length) best = entry
  }
  return best
}

/** `ModelsResponse` in codex's `model_catalog_json` shape. `bundled` = the installed codex's own catalog. */
export function codexModelCatalog(facts, bundled) {
  return {
    models: facts.map((model, priority) => {
      const known = bundledEntryFor(model.id, bundled)
      // Listed in directory order, callable over the platform provider's API key.
      const listing = { visibility: 'list', supported_in_api: true, priority }
      return known ? { ...known, slug: model.id, ...listing } : unknownModelEntry(model, listing)
    }),
  }
}

function unknownModelEntry(model, listing) {
  return {
    // ── declared by the gateway directory ──
    slug: model.id,
    display_name: model.displayName,
    context_window: model.contextWindow ?? CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW,
    max_context_window: model.contextWindow ?? CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW,
    supported_reasoning_levels: model.efforts.map((effort) => ({
      effort,
      description: `reasoning_effort=${effort}`,
    })),
    ...listing,
    // ── codex's own fallback descriptor, field for field ──
    base_instructions: CODEX_GENERIC_BASE_INSTRUCTIONS,
    // "default" is an alias codex resolves to its own per-version fallback shell tool.
    shell_type: 'default',
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    // Required by v0.147 (ignored by later versions); the fallback value.
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
  }
}

/**
 * Write this launcher's catalog and return the config override that points codex at it, plus the
 * models whose window the directory did not state (the caller logs them).
 * No facts in `env` (a session on the user's own Codex account) → nothing to write.
 */
export async function writeCodexModelCatalog(env, readBundledCatalog) {
  const raw = env[PLATFORM_MODELS_ENV]?.trim()
  if (!raw) return { args: [], windowUnknown: [], dispose() {} }
  const facts = platformModelFacts(raw)
  let bundled
  try {
    bundled = JSON.parse(await readBundledCatalog()).models
    if (!Array.isArray(bundled)) throw new Error('no "models" array')
  } catch (error) {
    // Without it every platform model codex does know (gpt-5.x) would lose its own metadata.
    throw new Error(
      `本机 Codex 报不出它自带的模型目录(\`codex debug models --bundled\`,需要 Codex ≥ 0.122);`
      + `请升级 Codex 后重试。原始错误:${error?.message ?? error}`,
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'gugu-codex-catalog-'))
  const file = join(dir, 'model-catalog.json')
  await writeFile(file, JSON.stringify(codexModelCatalog(facts, bundled)), { mode: 0o600 })
  return {
    // TOML basic string: JSON escaping is valid TOML for a path, backslashes included.
    args: ['-c', `model_catalog_json=${JSON.stringify(file)}`],
    windowUnknown: facts
      .filter((fact) => fact.contextWindow === null && !bundledEntryFor(fact.id, bundled))
      .map((fact) => fact.id),
    // Synchronous on purpose: the bridge disposes from its `exit` handler.
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Remember a read only once it succeeded. A rejection clears the memo, so the next caller reads again
 * (and reports again, loudly, if it still fails) — one transient failure must not stay broken for the
 * life of the bridge. No timed retries: the next real caller is the retry.
 */
export function memoizeSuccess(read) {
  let pending = null
  return () => {
    if (!pending) {
      const attempt = read()
      pending = attempt
      attempt.catch(() => {
        if (pending === attempt) pending = null
      })
    }
    return pending
  }
}
