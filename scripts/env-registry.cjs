// @@@env-registry - Playwright loads its root TypeScript config as CommonJS, while the build CLI is
// native ESM. Keep their shared synchronous env activation at this format-neutral boundary so both
// consumers execute one implementation without asking Playwright's require hook to transform .mjs.
// The consumers inject their existing fs/path adapter because Vite also bundles this module into an
// ESM config; a CommonJS builtin require here would become an unsupported dynamic require there.
const DB_TARGETS = Object.freeze(['prod', 'shared-test', 'local'])
const ENV_REGISTRY_DIR = '.envs'

// Both native ESM build tooling and Playwright's CommonJS config loader consume this value. Keep the
// literal at their existing format-neutral boundary so safety checks share one fact without crossing
// the loader boundary.
const PRODUCTION_DB_HOST = process.env.GUGU_PRODUCTION_DB_HOST || 'db.gugu.nextmind.space'

function registryFileFor(target) {
  return `${ENV_REGISTRY_DIR}/${target}.env`
}

// Deliberately supports only the dotenv subset used by the registry. Variable expansion would make
// the selected value's source ambiguous, while source attribution is the point of this mechanism.
function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      const close = value.indexOf(quote, 1)
      if (close !== -1) value = value.slice(1, close)
    } else if (value.startsWith('#')) {
      value = ''
    } else {
      const commentAt = value.search(/\s#/)
      if (commentAt !== -1) value = value.slice(0, commentAt).trimEnd()
    }
    if (key) out[key] = value
  }
  return out
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

let dbAnnounced = false

function resetDbAnnounceForTest() {
  dbAnnounced = false
}

function announceHostSource(env) {
  const direct = env.GUGU_SUPABASE_URL || env.VITE_SUPABASE_URL
  if (direct) return { url: direct, from: 'shell / 登记处' }
  return { url: null, from: null }
}

function createEnvRegistryRuntime({ existsSync, readFileSync, join }) {
  // A named target activates one complete registry file. No target means no implicit file selection.
  function loadActiveDbEnv(rootDir, processEnv = {}) {
    const target = processEnv.GUGU_DB_TARGET
    if (!target) return { values: {}, source: null, target: null }
    const file = join(rootDir, registryFileFor(target))
    if (!existsSync(file)) return { values: {}, source: null, target }
    return { values: parseEnvFile(readFileSync(file, 'utf8')), source: registryFileFor(target), target }
  }

  // Soft compatibility would hide a stale second credential container, so legacy .env.local fails loud.
  function assertNoLegacyEnvLocal(rootDir = process.cwd()) {
    const legacy = join(rootDir, '.env.local')
    if (!existsSync(legacy)) return
    throw new Error(
      `.env.local 已退役（#2782 → 一套环境一个文件）。它的内容不会再被读取，留着只会让人以为配置生效了。\n` +
        `  搬迁：node scripts/build-env-preflight.mjs --migrate <${DB_TARGETS.join('|')}>\n` +
        `  搬完 .env.local 会被删除，原件留在 .env.local.bak；核对无误后自行删掉 .bak。\n` +
        `  模板与全部键的说明见 .envs/example.env`,
    )
  }

  function applyActiveDbEnv(rootDir = process.cwd(), env = process.env) {
    const active = loadActiveDbEnv(rootDir, env)
    for (const [key, value] of Object.entries(active.values)) env[key] = value
    return active
  }

  // Diagnostics use stderr because several env consumers reserve stdout for structured output.
  function announceActiveDb(rootDir = process.cwd(), env = process.env, log = console.error) {
    if (dbAnnounced || env.GUGU_DB_QUIET) return null

    const target = env.GUGU_DB_TARGET || null
    const { url, from } = announceHostSource(env)
    const host = url ? hostOf(url) || url : null
    let line

    if (target && DB_TARGETS.includes(target)) {
      const file = registryFileFor(target)
      const fileExists = existsSync(join(rootDir, file))
      if (!fileExists && !host) {
        throw new Error(
          `[db] 声明了 GUGU_DB_TARGET=${target}，但 ${file} 不存在且 shell 没有库地址 —— ` +
            `请创建并填写 ${file}（见 .envs/example.env），或显式注入完整的 Supabase 环境。`,
        )
      }
      line = fileExists
        ? `[db] ${target} → ${host ?? '(无库地址)'}   ${file}`
        : `[db] 声明了 GUGU_DB_TARGET=${target}，但 ${file} 不存在 —— 落回 ${host ?? '(无库地址)'}（${from ?? '无来源'}）`
    } else if (target) {
      line = `[db] GUGU_DB_TARGET=${JSON.stringify(target)} 不是 ${DB_TARGETS.join(' / ')} 之一 —— 落回 ${host ?? '(无库地址)'}（${from ?? '无来源'}）`
    } else if (host) {
      line = `[db] 未声明 GUGU_DB_TARGET → ${host}（${from}）；设 GUGU_DB_TARGET=${DB_TARGETS.join('|')} 可让它变成硬核对`
    } else {
      line = `[db] 未声明 GUGU_DB_TARGET，也没找到库地址 —— 连接会 fail-loud。见 .envs/example.env`
    }

    dbAnnounced = true
    log(line)
    return { target, host, source: from, line }
  }

  return { announceActiveDb, applyActiveDbEnv, assertNoLegacyEnvLocal, loadActiveDbEnv }
}

exports.DB_TARGETS = DB_TARGETS
exports.ENV_REGISTRY_DIR = ENV_REGISTRY_DIR
exports.PRODUCTION_DB_HOST = PRODUCTION_DB_HOST
exports.createEnvRegistryRuntime = createEnvRegistryRuntime
exports.hostOf = hostOf
exports.parseEnvFile = parseEnvFile
exports.registryFileFor = registryFileFor
exports.resetDbAnnounceForTest = resetDbAnnounceForTest
