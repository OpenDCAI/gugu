// ❌ 不要给这个文件加 shebang。vite.config.mts 会 import 它，而 vite 加载 config 时给每个文件
// **前置**注入 __vite_injected_original_filename 等变量——shebang 因此不在第 0 位，esbuild 的
// shebang 处理不再生效，`#!` 变成语法错误，整个 renderer build 挂掉（CI 实测）。
// 本文件一律经 `node scripts/build-env-preflight.mts` 调用（644，从不直接执行），不需要 shebang。
// tests/unit/scripts/buildEnvPreflight.test.ts 用 vite 自己的 loadConfigFromFile 钉住这条。
// @@@build-env-preflight (#2782) — 打包前核对「这个包要连哪个库」，打包后核对「库地址真的烘进去了」。
//
// #398 让连接只来自 env、缺失即 fail-loud；#1972 给 CD 加了产物烘焙门。两次治理覆盖的都是「缺」。
// 本模块覆盖的是「有值但错配」：同一次构建里存在两条互不相干的解析通路，它们各自都「有值」，
// 但可以指向不同的库，而此前没有任何一层比对过它们。
//
//   通路 A（renderer inline）：vite 的 .env cascade + shell env
//     .env → .env.local → .env.[mode] → .env.[mode].local，后者覆盖前者；
//     最后 shell 里所有 VITE_* 无条件覆盖以上全部（vite loadEnv 末尾那个 process.env 循环）。
//   通路 B（烘焙 define __GUGU_DEFAULT_SUPABASE_*__）：只有 shell env
//     vite.config.mts 顶层的 process.env.GUGU_… || process.env.VITE_… 在 config 模块求值时读取，
//     那时 vite 还没加载任何 .env 文件，而 loadEnv 也只把 NODE_ENV/BROWSER 回写 process.env。
//     ⇒ .env.local 里的 GUGU_SUPABASE_URL 对通路 B 完全无效。
//
// 于是「shell 里残留 GUGU_SUPABASE_URL=A + .env.local 里 VITE_SUPABASE_URL=B」会打出一个
// renderer 连 B、CLI 冷启动连 A 的包，全程无提示。CD 三条道都只经 shell 注入 VITE_*，
// 两条通路天然一致，所以本闸对 CD 无行为变化。

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export type DbTarget = 'prod' | 'shared-test' | 'local'
export const DB_TARGETS: readonly DbTarget[] = Object.freeze(['prod', 'shared-test', 'local'] as const)
const isDbTarget = (value: unknown): value is DbTarget => DB_TARGETS.includes(value as DbTarget)
export const ENV_REGISTRY_DIR: string = '.envs'

// Both native ESM build tooling and Playwright's CommonJS config loader consume this value. Keep the
// literal at their existing format-neutral boundary so safety checks share one fact without crossing
// the loader boundary.
export const PRODUCTION_DB_HOST: string = process.env.GUGU_PRODUCTION_DB_HOST || 'db.gugu.nextmind.space'

export function registryFileFor(target: string): string {
  return `${ENV_REGISTRY_DIR}/${target}.env`
}

// Deliberately supports only the dotenv subset used by the registry. Variable expansion would make
// the selected value's source ambiguous, while source attribution is the point of this mechanism.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
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

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

let dbAnnounced = false

export function resetDbAnnounceForTest(): void {
  dbAnnounced = false
}

function announceHostSource(env: Record<string, string | undefined>): { url: string | null; from: string | null } {
  const direct = env.GUGU_SUPABASE_URL || env.VITE_SUPABASE_URL
  if (direct) return { url: direct, from: 'shell / 登记处' }
  return { url: null, from: null }
}

export interface ActiveDbEnv {
  values: Record<string, string>
  source: string | null
  target: string | null
}

export interface AnnouncedDb {
  target: string | null
  host: string | null
  source: string | null
  line: string
}

// A named target activates one complete registry file. No target means no implicit file selection.
export function loadActiveDbEnv(rootDir: string, processEnv: Record<string, string | undefined> = {}): ActiveDbEnv {
  const target = processEnv.GUGU_DB_TARGET
  if (!target) return { values: {}, source: null, target: null }
  const file = path.join(rootDir, registryFileFor(target))
  if (!existsSync(file)) return { values: {}, source: null, target }
  return { values: parseEnvFile(readFileSync(file, 'utf8')), source: registryFileFor(target), target }
}

// Soft compatibility would hide a stale second credential container, so legacy .env.local fails loud.
export function assertNoLegacyEnvLocal(rootDir: string = process.cwd()): void {
  const legacy = path.join(rootDir, '.env.local')
  if (!existsSync(legacy)) return
  throw new Error(
    `.env.local 已退役（#2782 → 一套环境一个文件）。它的内容不会再被读取，留着只会让人以为配置生效了。\n` +
      `  搬迁：node scripts/build-env-preflight.mts --migrate <${DB_TARGETS.join('|')}>\n` +
      `  搬完 .env.local 会被删除，原件留在 .env.local.bak；核对无误后自行删掉 .bak。\n` +
      `  模板与全部键的说明见 .envs/example.env`,
  )
}

export function applyActiveDbEnv(rootDir: string = process.cwd(), env: Record<string, string | undefined> = process.env): ActiveDbEnv {
  const active = loadActiveDbEnv(rootDir, env)
  for (const [key, value] of Object.entries(active.values)) env[key] = value
  return active
}

// Diagnostics use stderr because several env consumers reserve stdout for structured output.
export function announceActiveDb(
  rootDir: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.error,
): AnnouncedDb | null {
  if (dbAnnounced || env.GUGU_DB_QUIET) return null

  const target = env.GUGU_DB_TARGET || null
  const { url, from } = announceHostSource(env)
  const host = url ? hostOf(url) || url : null
  let line: string

  if (target && isDbTarget(target)) {
    const file = registryFileFor(target)
    const fileExists = existsSync(path.join(rootDir, file))
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

/**
 * The one node-side env bootstrap (vite config, Playwright config, integration tests): refuse the retired
 * .env.local, let the declared GUGU_DB_TARGET set win over stale shell exports, then say which database.
 */
export function activateDbEnv(rootDir: string = process.cwd(), env: Record<string, string | undefined> = process.env): void {
  assertNoLegacyEnvLocal(rootDir)
  applyActiveDbEnv(rootDir, env)
  announceActiveDb(rootDir, env)
}

// 给别的机器装哪条通道的 server:跟这次构建连的库走,❌ 跟构建类型(tier)走。正式通道的包烘的是生产库,Beta 通道
// 烘的是共享测试库(gugu-dev 两条出包道各自的 environment)。开发构建的 tier 默认也是 production,按 tier 选会让
// 连测试库的开发版装上连生产库的 server,测试账号的登录码被送去生产库(10-28 真机撞到)。
// 生产库以外一律 Beta:自建的本地库没有发布过的包,要用 GUGU_SERVER_DOWNLOAD_BASE 指到自己打的包。
// 烘进产物的只有通道名:❌ 把生产库 host 烘进主进程 —— verifyDistBake 靠在产物里找这个 host 判断库地址烘进去了没有。
export function serverChannelForDb(url: string | null | undefined): 'stable' | 'beta' {
  return hostOf(url ?? '') === PRODUCTION_DB_HOST ? 'stable' : 'beta'
}

// vite 的 cascade 顺序（弱 → 强）。这是 vite 内部 getEnvFilesForMode 的顺序，不是文档转述；
// tests/unit/scripts/buildEnvPreflight.test.ts 用真 loadEnv 把它钉住，vite 改了顺序测试就红。
export interface EnvSlot {
  value: string
  source: string | null
}

export interface ResolvedBuildEnv {
  renderer: { url: EnvSlot; anonKey: EnvSlot }
  baked: { url: EnvSlot; anonKey: EnvSlot }
}

export function envFileOrder(mode: string): string[] {
  return [`.env`, `.env.local`, `.env.${mode}`, `.env.${mode}.local`]
}

// envFiles 按 cascade 顺序（弱在前）给，每项 { name, values }。processEnv 为 shell 环境。
// 返回两条通路各自的值与来源；来源是给人看的，出问题时「谁把它盖掉了」必须一眼可见。
// processEnvLabel：选中某套后这些值其实来自登记处而非用户的 shell，标成 "shell env" 会误导
// —— 排错时「谁给的这个值」必须指得准，指错等于把人往错误的文件上引。
export function resolveBuildEnv({
  envFiles = [],
  processEnv = {},
  processEnvLabel = 'shell env',
}: {
  envFiles?: Array<{ name: string; values?: Record<string, string> }>
  processEnv?: Record<string, string | undefined>
  processEnvLabel?: string
} = {}): ResolvedBuildEnv {
  const fromCascade = (key: string): EnvSlot => {
    // shell 一旦定义就赢，**哪怕是空串**——vite 的覆盖循环不判空。这正是 #2710 那类
    // 「export 了个空值把文件里的好值抹掉」的形状，必须能被指认出来，不能静默当作未设置。
    if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
      return { value: processEnv[key] ?? '', source: processEnvLabel }
    }
    let hit: EnvSlot = { value: '', source: null }
    for (const file of envFiles) {
      const v = file.values?.[key]
      if (v !== undefined) hit = { value: v, source: file.name }
    }
    return hit
  }

  // 通路 B 精确镜像 vite.config.mts 的 `GUGU_… || VITE_… || ''`：`||` 会让空串继续下落。
  const fromShellOnly = (guguKey: string, viteKey: string): EnvSlot => {
    if (processEnv[guguKey]) return { value: processEnv[guguKey]!, source: `${processEnvLabel} ${guguKey}` }
    if (processEnv[viteKey]) return { value: processEnv[viteKey]!, source: `${processEnvLabel} ${viteKey}` }
    return { value: '', source: null }
  }

  return {
    renderer: {
      url: fromCascade('VITE_SUPABASE_URL'),
      anonKey: fromCascade('VITE_SUPABASE_ANON_KEY'),
    },
    baked: {
      url: fromShellOnly('GUGU_SUPABASE_URL', 'VITE_SUPABASE_URL'),
      anonKey: fromShellOnly('GUGU_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'),
    },
  }
}

// anon key 可能是 JWT，也可能是新式 sb_publishable_… ——后者无法离线取证。
// 认不出就返回 null，由调用方降级为「不可离线核对」，❌ 不因为格式不认识就拦构建。
export function decodeJwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    return null
  }
}

// ⚠ 只断言「是不是生产库」，不试图区分 shared-test 与 local。
// 第一版按「回环 = local、非回环 = shared-test」判，方向是错的：共享测试库本身就经 SSH 隧道
// 走 127.0.0.1:<port>（account 工厂 + 红线只认 loopback），
// 于是文档里那条 `GUGU_DB_TARGET=shared-test pnpm build:app` 对所有按标准姿势配置的人都 exit 1。
// URL 上根本区分不了这两者，就别假装能分 —— 假判据比没判据坏，它会把对的拦下、把错的放过。
// 真正值钱且可判的只有一条：**生产库不能被当成非生产用，非生产也不能是生产库。**
export function checkTargetHost(target: string, host: string | null): string | null {
  if (!host) return `无法从 URL 解析出 host`
  if (!isDbTarget(target)) {
    return `GUGU_DB_TARGET 只接受 ${DB_TARGETS.join(' / ')}，收到 ${JSON.stringify(target)}`
  }
  const isProdHost = host === PRODUCTION_DB_HOST
  if (target === 'prod') {
    return isProdHost ? null : `声明了 prod，但 host 是 ${host}（应为 ${PRODUCTION_DB_HOST}）`
  }
  return isProdHost ? `声明了 ${target}，但 host 是生产库 ${host}` : null
}

// 只在证据确凿时报 error：
//   - 两条通路给出不同的库（无歧义，且与 key 格式无关）
//   - 打包构建缺 URL / anon key（0.2.18 事故的形状）
//   - 显式声明的 target 与 host 不符（用户自己声明的，不符就是错）
//   - URL 是 *.supabase.co 且 key 是能解出 ref 的 JWT，但 ref 与 URL 对不上
// 其余一律 warning：拦不住的东西不假装拦住，也不因为无法取证就阻断 CD。
export function checkBuildEnv({
  renderer,
  baked,
  target = null,
}: ResolvedBuildEnv & { target?: string | null }): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  const need = (label: string, slot: EnvSlot) => {
    if (slot.value) return true
    errors.push(
      slot.source === 'shell env'
        ? `${label} 在 shell 里被导出为空串，覆盖掉了 .env 文件里的值 —— unset 它，或给它真实值`
        : `${label} 缺失：打包产物将不含库地址（0.2.18 事故形状：出厂即永远「加载中」）`
    )
    return false
  }

  const haveRendererUrl = need('renderer 的 VITE_SUPABASE_URL', renderer.url)
  need('renderer 的 VITE_SUPABASE_ANON_KEY', renderer.anonKey)

  // 通路分裂：两边都有值却不相等。这是本 issue 的主犯，无条件 error。
  for (const [label, a, b] of [
    ['URL', renderer.url, baked.url],
    ['anon key', renderer.anonKey, baked.anonKey],
  ] as const) {
    if (a.value && b.value && a.value !== b.value) {
      errors.push(
        `renderer 与烘焙 define 的 ${label} 不一致 —— 同一个包会连两个库。` +
          `renderer=${describe(a)}；烘焙=${describe(b)}`
      )
    }
  }

  // 烘焙缺失不致命（renderer 已 inline，桌面端能跑），但 CLI 冷启动会 fail-loud，值得说。
  if (renderer.url.value && !baked.url.value) {
    warnings.push(
      `烘焙 define 为空：shell 里没有 GUGU_SUPABASE_URL / VITE_SUPABASE_URL，` +
        `.env 文件对它无效 —— 产物里 CLI 冷启动(gugu login)会缺库地址`
    )
  }

  if (haveRendererUrl) {
    const host = hostOf(renderer.url.value)
    if (!host) errors.push(`VITE_SUPABASE_URL 不是合法 URL：${renderer.url.value}`)
    if (target) {
      const problem = checkTargetHost(target, host)
      if (problem) errors.push(`GUGU_DB_TARGET 核对失败：${problem}`)
    } else if (host) {
      warnings.push(
        `未声明 GUGU_DB_TARGET —— 本次将把 ${host} 烘进产物。` +
          `设 GUGU_DB_TARGET=prod|shared-test|local 可让这一步变成硬核对`
      )
    }

    // URL 与 key 是否属于同一个实例。托管域名能从子域推出 ref，自部署推不出，只能降级。
    const claims = decodeJwtClaims(renderer.anonKey.value)
    const hosted = host && /^([a-z0-9]+)\.supabase\.co$/.exec(host)
    if (hosted && typeof claims?.ref === 'string' && claims.ref !== hosted[1]) {
      errors.push(`anon key 属于项目 ${claims.ref}，但 URL 指向 ${hosted[1]} —— 地址与密钥不是一套`)
    } else if (!claims && renderer.anonKey.value) {
      warnings.push(`anon key 不是 JWT，无法离线核对它与 ${host} 是否同一套（新式 sb_* key 属正常）`)
    } else if (typeof claims?.exp === 'number' && claims.exp * 1000 < Date.now()) {
      errors.push(`anon key 已于 ${new Date(claims.exp * 1000).toISOString()} 过期`)
    }
  }

  return { errors, warnings }
}

function describe(slot: EnvSlot): string {
  if (!slot.value) return slot.source ? `（空，被 ${slot.source} 置空）` : '（未设置）'
  return `${hostOf(slot.value) ?? slot.value}（来自 ${slot.source}）`
}

// ── 脚本侧共享 env 读取 ──────────────────────────────────────────────────────
// @@@script-env-loader - 此前 11 个脚本各自抄了一份同样的十行 .env.local 解析器
// （thread-mcp-probe / whisper-*-smoke / agent-lifecycle-*-verify / acp-stdio-probe /
// listen-mode-persist-smoke / …），逐字一样，连变量名从 value 抄成 v 的痕迹都在。
//
// 复制粘贴本身不是重点。真正的代价是「env 从哪来」这件事**没有归属**：想换个来源就得
// 同时改十一处，于是谁都不敢换 —— .env.local 退不掉的根因就在这儿，不在它本身。
// 收口到这里之后，换来源是一处一行。
//
// ⚠ 与被替换的那十一份**不是**逐字等价：parseEnvFile 在三处更严格，而三处都是手抄版写错的
//   —— `export KEY=v` 的键名（手抄版解析成 "export KEY"）、行尾 ` # 注释`、`KEY="v" # 注释`
//   的引号。这三条正是 vite/dotenv 读 .env.local 时的语义，手抄版才是不一致的那个。
//
// 调用方保持 `{ ...readScriptEnv(), ...process.env }` 的优先级：文件垫底，shell 覆盖。
export function readScriptEnv(rootDir: string = process.cwd(), env: Record<string, string | undefined> = process.env): Record<string, string> {
  assertNoLegacyEnvLocal(rootDir)
  const target = env.GUGU_DB_TARGET
  if (!target || !isDbTarget(target)) return {}
  const file = path.join(rootDir, registryFileFor(target))
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}
}

// ── 三库凭据登记处 ──────────────────────────────────────────────────────────
// 咕咕有三套库（生产 / 共享测试 / 本机），每套的 URL 与密钥都不同。而 .env.local 只装得下
// 一套，另外两套无处可放 —— 于是只能靠脑子记，记错就是「连错库」。所以三套各存一份。
//
// 存在 .envs/ 子目录而不是 .env.<name>：vite 会自动加载 .env.<mode>（mode=production 时就是
// .env.production），一旦存储文件落进它的 cascade，存储就等于激活，而且是**叠加**式激活 ——
// mode 文件没写全的键会静默落回 .env.local，凑出 URL 与密钥分属两库的半套错。
// 子目录 vite 从不扫，所以 .envs/ 里的三套是纯惰性存储，只有被显式选中才整套生效。
// 一套凭据必须写全的四个连接键：缺任何一个都会静默落回别处，凑出半套错。
export const DB_CONNECTION_KEYS: readonly string[] = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'GUGU_SUPABASE_URL',
  'GUGU_SUPABASE_ANON_KEY',
])

// 归属这套库、跟着 target 走的全部键（含 service_role：它是分库的，生产那把对 dev 库 401）。
// 「必须写全」只要求上面四个；service_role 选填，但填了就跟着整套生效、也参与遮蔽检查。
export const DB_ENV_KEYS: readonly string[] = Object.freeze([...DB_CONNECTION_KEYS, 'SUPABASE_SERVICE_ROLE_KEY'])

// 也是分库的，但不影响构建：`pnpm seed:yatu-accounts` 把 Alice/Bob 建在当时指向的那个库里，
// 换了 target 这两个账号就不存在。所以跟着 target 走，但缺了不拦（只有集成测试才用得上），
// 留在 .env.local 里也只 warn —— 它不会让你打出连错库的包，够不上 error。
export const DB_OPTIONAL_KEYS: readonly string[] = Object.freeze([
  'ALICE_EMAIL',
  'ALICE_PASSWORD',
  'ALICE_NICKNAME',
  'BOB_EMAIL',
  'BOB_PASSWORD',
])

// 选中一套并整体生效。要点：
//   - 整套注入，❌ 不与任何其它来源合并 —— 合并正是半套错的来源。
//   - 同时注入 VITE_* 与 GUGU_*，于是 renderer 与烘焙 define 两条通路**由构造保证一致**，
//     而不是靠事后比对才发现不一致。这是本模块从「检测」升级到「消除」的那一步。
//   - .env.local 里若还留着库相关的键，它们已经是过期副本 → 报错要求搬走，不静默共存。
export function selectTargetEnv({
  target,
  registryValues = null,
  localValues = {},
  shellEnv = {},
}: {
  target?: string
  registryValues?: Record<string, string> | null
  localValues?: Record<string, string>
  shellEnv?: Record<string, string | undefined>
} = {}): { injected: Record<string, string>; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isDbTarget(target)) {
    return { injected: {}, errors: [`GUGU_DB_TARGET 只接受 ${DB_TARGETS.join(' / ')}，收到 ${JSON.stringify(target)}`], warnings }
  }
  if (!registryValues) {
    // 登记处是给人用的便利，不是唯一合法来源。CI 直接从 secrets 往 shell 注 VITE_*，
    // .envs/ 被 gitignore 根本不会出现在 runner 上 —— 那种情况下 target 只该表示
    // 「核对我连的是不是 X」，❌ 不该反过来要求必须存在某个文件，否则给 CI 加上
    // GUGU_DB_TARGET 就会让三条发版道全挂。
    if (shellEnv.VITE_SUPABASE_URL && shellEnv.VITE_SUPABASE_ANON_KEY) {
      return {
        injected: {},
        errors: [],
        warnings: [`${registryFileFor(target)} 不存在，本次用 shell 里已有的那套（CI 注入即此形态），仅做 host 核对`],
      }
    }
    return {
      injected: {},
      errors: [
        `声明了 GUGU_DB_TARGET=${target}，但 ${registryFileFor(target)} 不存在、shell 里也没有整套凭据。` +
          `建这个文件，把这套库的 ${DB_ENV_KEYS.join(' / ')} 填进去（该目录已 gitignore）。`,
      ],
      warnings,
    }
  }

  const injected: Record<string, string> = {}
  for (const key of [...DB_ENV_KEYS, ...DB_OPTIONAL_KEYS]) {
    const value = registryValues[key]
    if (value) injected[key] = value
  }

  // ❌ service_role 不进必填：gugu-db skill 明说不是人人都有它（「自己有 SUPABASE_SERVICE_ROLE_KEY
  // 的话」），必填会把普通贡献者挡在门外。防「用错某个库的 service」靠的是下面那条
  // 「shell 里有、登记处没有」的检查，不是靠强迫每个人都填一把管理员密钥。
  for (const key of DB_CONNECTION_KEYS) {
    if (!injected[key]) errors.push(`${registryFileFor(target)} 缺 ${key} —— 一套凭据必须写全，缺哪个都会静默落回别处`)
  }

  // 过期副本：留着不报，下次有人 source .env.local 就又把错的值带回来了。
  const staleLocal = DB_ENV_KEYS.filter((key) => localValues[key] !== undefined)
  if (staleLocal.length) {
    errors.push(
      `.env.local 里仍有库相关的键（${staleLocal.join(' / ')}）—— 已选 ${target}，` +
        `这些是过期副本。把它们搬进 ${ENV_REGISTRY_DIR}/ 对应那套，.env.local 只留签名 / OSS / 下载源这类与库无关的配置。`
    )
  }

  const staleOptional = DB_OPTIONAL_KEYS.filter((key) => localValues[key] !== undefined)
  if (staleOptional.length) {
    warnings.push(
      `.env.local 里的测试账号（${staleOptional.join(' / ')}）也是分库的 —— ` +
        `换 target 后这些账号在新库里并不存在。建议搬进 ${registryFileFor(target)}`
    )
  }

  // shell 里的同名 export 会被整套覆盖掉。这是想要的（残留 export 正是连错库的老源头），
  // 但必须说出来 —— 静默覆盖会让人以为自己的 export 生效了。
  const overridden = Object.keys(injected).filter((key) => shellEnv[key] && shellEnv[key] !== injected[key])
  if (overridden.length) {
    warnings.push(`shell 里的 ${overridden.join(' / ')} 与所选的 ${target} 不同，已按 ${target} 整套覆盖`)
  }
  // 覆盖只能盖住登记处**有**的键。登记处没有、shell 却有的库键会原封不动活下来,
  // 这是「整套生效」这句话唯一漏风的地方,必须点名。
  const unshadowed = DB_ENV_KEYS.filter((key) => shellEnv[key] && !injected[key])
  if (unshadowed.length) {
    errors.push(
      `shell 里的 ${unshadowed.join(' / ')} 不在 ${registryFileFor(target)} 里,整套覆盖盖不住它 —— ` +
        `它会带着上一个库的值进构建。补进登记文件,或 unset 掉。`
    )
  }

  return { injected, errors, warnings }
}

// #1972 的门本机版：产物里必须真出现库 host。CI 对最终 artifact 做，这里对 vite 的
// dist 输出做——asar 已关(@@@kill-asar)，dist 到安装包是直拷，在 electron-builder 之前
// 就能拦住坏包，且不依赖各平台 artifact 的目录形状。
// readText 让调用方决定「什么时候把文件读进内存」：CLI 传逐文件读取，于是任一时刻只有一份
// 文件内容在堆上，且命中即退。❌ 不要先把整个 dist 收成 {path,text}[] —— Windows 那条打包道
// 已经贴着 V8 堆上限跑（cd-release.yml 给它加了 --max-old-space-size=6144 才不 OOM），
// 在它前面插一次全量 slurp 等于替它把堆吃掉。
// 两个目录都得扫:renderer 输出在根 dist,而烘焙 define(__GUGU_DEFAULT_SUPABASE_*__)落在
// apps/desktop/dist-electron。只扫根 dist 的话,这道叫「烘焙门」的闸恰恰扫不到烘焙 define,
// 通路 B 永远判不了 —— 它只是在重复验证 renderer inline。
export const BAKE_SCAN_DIRS: readonly string[] = Object.freeze(['dist', 'apps/desktop/dist-electron'])

export interface BakeCandidate {
  path?: string
  text?: string
}

export function verifyDistBake({
  files = [],
  expectedHost,
  readText = (file) => file.text,
}: {
  files?: BakeCandidate[]
  expectedHost: string | null
  readText?: (file: BakeCandidate) => string | undefined
}): { hits: number; errors: string[] } {
  if (!expectedHost) return { hits: 0, errors: [`无法核对烘焙：没有可比对的 host`] }
  let hits = 0
  for (const file of files) {
    const text = readText(file) ?? ''
    // indexOf 循环而不是 split：split 会为一个几十 MB 的 bundle 额外分配整个碎片数组。
    for (let at = text.indexOf(expectedHost); at !== -1; at = text.indexOf(expectedHost, at + 1)) hits++
    if (hits > 0) break // 这是道「有没有」的闸，不是统计——够了就别把剩下的 dist 也读一遍
  }
  return {
    hits,
    errors: hits > 0 ? [] : [`产物里 ${expectedHost} 出现 0 次 —— env 没被 inline，拒绝继续打包（#1972 同型）`],
  }
}

// 只返回路径，不读内容（读取交给 verifyDistBake 的 readText）。
export function listBakeCandidates(dir: string, out: BakeCandidate[] = []): BakeCandidate[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    // lstat 而不是 stat：dist 里若有指向仓外的符号链接，跟进去既慢又可能死循环。
    const info = lstatSync(full)
    if (info.isDirectory()) listBakeCandidates(full, out)
    else if (info.isFile() && /\.(js|mjs|cjs|html)$/.test(entry)) out.push({ path: full })
  }
  return out
}

function readCascade(rootDir: string, mode: string): Array<{ name: string; values: Record<string, string> }> {
  return envFileOrder(mode).map((name) => {
    const full = path.join(rootDir, name)
    return { name, values: existsSync(full) ? parseEnvFile(readFileSync(full, 'utf8')) : {} }
  })
}

// warnings 默认空数组：烘焙门只产 errors，早期版本在这里直接解构迭代，一跑就 TypeError。
function report({ errors = [], warnings = [] }: { errors?: string[]; warnings?: string[] }, header: string): void {
  console.log(header)
  for (const w of warnings) console.log(`  ⚠ ${w}`)
  for (const e of errors) console.error(`  ✖ ${e}`)
  if (errors.length) {
    console.error(
      `\n构建已中止。核对 .env.local 与当前 shell 的 export（两者优先级不同），` +
        `或用 GUGU_SKIP_ENV_PREFLIGHT=1 自担风险跳过。`
    )
    process.exit(1)
  }
  console.log('  ✓ 通过')
}

function readFileValues(full: string): Record<string, string> | null {
  return existsSync(full) ? parseEnvFile(readFileSync(full, 'utf8')) : null
}

// 把 .env.local **整份**搬进 .envs/<target>.env,然后删掉它。
//
// @@@one-file-per-env - 上一版只搬「库相关」的键、把其余留在 .env.local,于是两个容器并存,
// 而其中一个（.env.local）根本没有自动加载路径。现在一套环境 = 一个文件,整份搬走、原地不留。
// ❌ 不静默覆盖已有登记文件；❌ 不打印任何值（只打印键名）；改写前先留 .env.local.bak ——
// 这文件里是人家的密钥,搬错了得能原样退回去。
function migrate(rootDir: string, target: string): void {
  if (!isDbTarget(target)) {
    console.error(`--migrate 只接受 ${DB_TARGETS.join(' / ')}，收到 ${JSON.stringify(target)}`)
    process.exit(1)
  }
  const localPath = path.join(rootDir, '.env.local')
  if (!existsSync(localPath)) {
    console.error(`没有 .env.local 可搬（${localPath}）`)
    process.exit(1)
  }
  const registryPath = path.join(rootDir, registryFileFor(target))
  if (existsSync(registryPath)) {
    console.error(`${registryFileFor(target)} 已存在 —— ❌ 不覆盖。先看一眼它，确认要合并还是改用别的 target。`)
    process.exit(1)
  }

  const body = readFileSync(localPath, 'utf8')
  const moved = body.split(/\r?\n/)
  const movedKeys = moved
    .map((line) => line.trim().replace(/^export\s+/, ''))
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
  if (!movedKeys.length) {
    console.log('.env.local 里没有任何键，直接删掉即可。')
    return
  }

  // 备份也不覆盖。前一版只给登记文件加了「已存在就不覆盖」,备份却直接盖 ——
  // 搬第二次就把第一次的原件冲掉了,而这个文件正是「搬错了能退回去」的唯一依靠。
  const backupPath = `${localPath}.bak`
  if (existsSync(backupPath)) {
    console.error(`${path.basename(backupPath)} 已存在 —— ❌ 不覆盖。先核对并删掉它，再重跑。`)
    process.exit(1)
  }

  const missing = DB_ENV_KEYS.filter((key) => !movedKeys.includes(key))

  mkdirSync(path.dirname(registryPath), { recursive: true })
  writeFileSync(registryPath, `# 由 --migrate 从 .env.local 整份搬来（target=${target}）\n${moved.join('\n').replace(/\n{3,}$/, '\n')}\n`, { mode: 0o600 })
  writeFileSync(backupPath, body, { mode: 0o600 })
  // 整份搬走就得原地删掉 —— 留个空壳会让 assertNoLegacyEnvLocal 继续拦人,
  // 而人以为"我已经搬完了"，卡在一条自己看不懂的报错上。
  rmSync(localPath)

  console.log(`已搬 ${movedKeys.length} 个键到 ${registryFileFor(target)}：${movedKeys.join(' / ')}`)
  console.log(`.env.local 已删除，原件备份在 .env.local.bak —— 核对无误后自行删除。`)
  // 半套搬迁要当场说。GUGU_* 常常只在 shell 里 export、从不写进文件,这种 .env.local 搬出来
  // 就是个残缺的登记文件,下一条构建命令才报错,那时人已经不知道是搬迁造成的。
  if (missing.length) {
    console.log(`⚠ ${registryFileFor(target)} 还缺 ${missing.join(' / ')} —— 补齐再用，否则构建会中止。`)
  } else {
    console.log(`现在可以：GUGU_DB_TARGET=${target} pnpm build:app`)
  }
}

function main(argv: string[]): void {
  const migrateAt = argv.indexOf('--migrate')
  if (migrateAt !== -1) {
    migrate(process.cwd(), argv[migrateAt + 1])
    return
  }
  if (process.env.GUGU_SKIP_ENV_PREFLIGHT === '1') {
    console.log('build-env-preflight: 已被 GUGU_SKIP_ENV_PREFLIGHT=1 跳过（自担风险）')
    return
  }
  const rootDir = process.cwd()
  const mode = process.env.GUGU_BUILD_MODE || 'production'
  const target = process.env.GUGU_DB_TARGET || null

  // 选中的那一套整体注入，覆盖 shell 与 .env 文件 —— renderer 与烘焙 define 从此同源。
  let selection: { injected: Record<string, string>; errors: string[]; warnings: string[] } = { injected: {}, errors: [], warnings: [] }
  if (target) {
    selection = selectTargetEnv({
      target,
      registryValues: readFileValues(path.join(rootDir, registryFileFor(target))),
      localValues: readFileValues(path.join(rootDir, '.env.local')) ?? {},
      shellEnv: process.env,
    })
  }
  const effectiveEnv = { ...process.env, ...selection.injected }
  const resolved = resolveBuildEnv({
    envFiles: readCascade(rootDir, mode),
    processEnv: effectiveEnv,
    // 只有真从登记处注了值才标成登记文件名。CI 那种「声明了 target 但没有登记文件」的形态,
    // 值其实来自 shell —— 标成文件名会自相矛盾(紧接着还打印「该文件不存在」),
    // 还会让 need() 里 `source === 'shell env'` 那条空串诊断失效。
    processEnvLabel: target && Object.keys(selection.injected).length ? registryFileFor(target) : 'shell env',
  })

  // 安卓壳的 build.gradle 拿它填 App Links 的主机(server-login 链接直接进 App):与网页构建同一个选库,❌ 另写一份。
  // 只打主机一行;解析不出 = 非零退出,gradle 那边当场报错。
  if (argv.includes('--print-host')) {
    const host = hostOf(resolved.renderer.url.value)
    if (selection.errors.length || !host) {
      console.error(`build-env-preflight --print-host: ${[...selection.errors, host ? '' : '没有可用的 Supabase URL'].filter(Boolean).join('；')}`)
      process.exit(1)
    }
    console.log(host)
    return
  }

  const distIndex = argv.indexOf('--verify-dist')
  if (distIndex !== -1) {
    const arg = argv[distIndex + 1]
    const dirs = (arg && !arg.startsWith('--') ? [arg] : BAKE_SCAN_DIRS).map((d) => path.resolve(rootDir, d))
    const host = hostOf(resolved.renderer.url.value)
    // 逐目录各自断言，❌ 不能把两处文件合成一堆「任一命中就放行」—— 那样 renderer 有、
    // 烘焙 define 没有的包照样过关，而通路 B 判不了正是这道门要修的东西。
    // 存在的产物目录都必须各自带上正确的库地址；没构建出来的目录跳过（不是每次都出两份）。
    const present = dirs.filter((d) => existsSync(d))
    const bake = present.length
      ? present
          .map((d) => ({
            dir: d,
            result: verifyDistBake({
              files: listBakeCandidates(d),
              expectedHost: host,
              readText: (file) => readFileSync(file.path!, 'utf8'),
            }),
          }))
          .reduce(
            (acc, { dir, result }) => ({
              errors: [
                ...acc.errors,
                ...result.errors.map((e) => `${path.relative(rootDir, dir) || '.'}：${e}`),
              ],
            }),
            { errors: [] as string[] }
          )
      : { errors: [`没有可核对的产物目录（${dirs.map((d) => path.relative(rootDir, d)).join(' / ')} 都不存在）`] }
    // 选套本身就错时(target 名乱写、.env.local 里还留着过期副本)不能只报烘焙结果就 exit 0 ——
    // gate:bake 是能被单独调用的脚本,吞掉根因等于把错配悄悄放行。
    report(
      { errors: [...selection.errors, ...bake.errors], warnings: selection.warnings },
      `烘焙门：逐个核对 ${(present.length ? present : dirs).map((d) => path.relative(rootDir, d) || '.').join(' / ')} 是否各自含 ${host}`
    )
    return
  }

  const source = target ? `${registryFileFor(target)}（整套生效）` : '未声明 target，按 .env cascade + shell 解析'
  console.log(
    `build-env-preflight：renderer=${describe(resolved.renderer.url)}｜` +
      `烘焙=${describe(resolved.baked.url)}｜来源=${source}`
  )
  // 选套本身就失败时，后续「缺 URL / 缺 anon key」全是它的下游症状 —— 一起报只会淹掉根因。
  const checked = selection.errors.length ? { errors: [], warnings: [] } : checkBuildEnv({ ...resolved, target })
  report(
    {
      errors: [...selection.errors, ...checked.errors],
      warnings: [...selection.warnings, ...checked.warnings],
    },
    '打包前核对：'
  )

}

// realpathSync 不能省：node 把 import.meta.url 解成真实路径，而 argv[1] 保留调用时的软链路径。
// 少了它，从任何软链路径（macOS 的 /tmp → /private/tmp、~/dev → /Volumes/…、部分 CI checkout
// 布局）调用本脚本都会静默变成空操作 —— 一道 exit 0 却什么都没做的闸比没有还危险。
if (process.argv[1]) {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p // 解不出就用原路径比：失败方向是「照常运行」，不是「静默跳过」
    }
  }
  if (real(fileURLToPath(import.meta.url)) === real(path.resolve(process.argv[1]))) main(process.argv.slice(2))
}
