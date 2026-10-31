// Vitest project: gugu.
//
// harness adapter 端口的**稠密矩阵**(草案骨架):行 = 上架的各家 harness,列 = 端口的每一项 × 形态(终端 / ACP)。
// 每个格子由同一份判据判成四种之一:
//
//   auto        这一家声明了这一项,宿主侧没有任何一行是专门为这一家写的 —— 接一家新 harness 时这一格「自动就通」
//   fixed       这一格能用,但宿主侧有为这一家专门写的代码(按 id / 方言 / 它的环境变量名点名)—— 「修了才通」
//   unsupported 这一家显式说「不支持」(没有这条腿、`kind: 'none'`、degraded 声明)
//   missing     端口要求这一项必答,而这一家什么都没声明,宿主也没替它写
//
// owner 的读数:好的端口让 auto / fixed 越来越大。每一步迁移报这两个数,`port-matrix.baseline.json` 是棘轮:
// auto 只许涨、fixed 与 missing 只许降。
//
// ⚠️ 仪器的可见域:「专门写的代码」用**字面量**判(这一家的 id、别名、方言名、`<ID>_*` 环境变量名、`.<id>` 目录名),
//    在每一项登记的宿主文件里找,注释不算。所以它看得见字符串分派(那正是 LSP 看不见的那一半),但看不见
//    「按结构推导、碰巧只对一家成立」的代码;宿主文件登记漏了的,在下面 `unassigned` 里单独列出,不进矩阵。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSessionCoexistence, resolveUnitDelivery } from '@gugu/session-core/agents/plugins'
import { listUserExposedPlugins, pluginRegistry } from '@gugu/session-plugins/agents'
import { findInjectionContract } from '../../../apps/desktop/electron/engine-injection-contract'
import { sessionRecordHarnessForProvider } from '../../../apps/desktop/electron/session/main/core/session-timeline/locate'
import baseline from './port-matrix.baseline.json'

type Surface = 'tui' | 'acp'
type Cell = 'auto' | 'fixed' | 'unsupported' | 'missing'
type Plugin = ReturnType<typeof pluginRegistry.getAll>[number]
type Declared = 'declared' | 'unsupported' | 'missing'

const ROOT = join(__dirname, '../../..')

/** 这一家的终端形态是哪条腿:codex 的终端走 app-server(可见 TUI 只是它的客户端)。 */
function legOf(plugin: Plugin, surface: Surface): 'tui' | 'app-server' | 'acp' | null {
  const surfaces = plugin.capabilities.sessionBundle.surfaces as readonly string[]
  if (surface === 'acp') return surfaces.includes('acp') ? 'acp' : null
  return surfaces.includes('tui') ? 'tui' : surfaces.includes('app-server') ? 'app-server' : null
}
const SURFACES: readonly Surface[] = ['tui', 'acp']
/** owner 要求进矩阵、但不在上架名单里的家:注册表里有就按真插件量,没有(还没合进 dev)整行记 missing。 */
const EXTRA_ROWS = ['zcode']

/**
 * 端口的十项。`declared` 只读这一家的插件声明;`host` 是这一项在宿主侧的实现文件(目录或文件,相对仓根)。
 * 这张表就是端口草案的可执行版本 —— 字段名、哪些腿要答,和那页草案逐项对应。
 */
const PORT: ReadonlyArray<{
  item: string
  declared: (plugin: Plugin, surface: Surface) => Declared
  host: readonly string[]
}> = [
  {
    item: 'launch', // 启动命令与权限档旗标
    declared: (plugin, surface) => {
      if (surface === 'acp') return plugin.capabilities.acp.kind === 'supported' ? 'declared' : 'unsupported'
      return plugin.capabilities.prompt.kind === 'none' ? 'unsupported' : 'declared'
    },
    host: [
      'apps/desktop/electron/session/main/core/sessions/resolve-agent-session-command.ts',
      'apps/desktop/src/session/renderer/features/sessions/session-config',
      'apps/desktop/electron/session/main/embedded-boot.ts',
    ],
  },
  {
    item: 'credentials', // 凭据、登录、多账号连接
    declared: (plugin) => (plugin.capabilities.auth.kind === 'supported' ? 'declared' : 'unsupported'),
    host: [
      'apps/desktop/electron/session/main/core/agents/harness-connections.ts',
      'apps/desktop/electron/session/main/core/agents/harness-connection-launch.ts',
      'apps/desktop/electron/session/main/core/agents/agent-run-context.ts',
      'packages/session-runtime/src/agent-config',
      'packages/session-core/src/workspace-server/agent-config',
      'apps/desktop/src/session/renderer/features/settings/subscriptions',
      'packages/session-core/src/agents/agent-env.ts',
      'apps/desktop/electron/acp-engine-utils.ts',
      'packages/session-core/src/acp/sign-in-failure.ts',
    ],
  },
  {
    item: 'modelRouting', // 平台模型:协议、方言、注入拓扑
    declared: (plugin, surface) => {
      const contract = findInjectionContract(plugin.metadata.id, surface === 'tui' ? 'tui' : 'cui')
      if (contract) return contract.wired ? 'declared' : 'unsupported'
      // 显式声明了 unsupported 的家算 unsupported;什么都没声明(dev 上 platform 字段还不存在)算 missing。
      const platform = (plugin.capabilities.sessionBundle as { platform?: { kind: string } }).platform
      if (platform?.kind === 'unsupported') return 'unsupported'
      // 这条腿没有注入拓扑,但插件自己的物化器在这条腿上送模型(units.model native,宿主把平台声明交给它)。
      const leg = legOf(plugin, surface)
      if (platform?.kind === 'supported' && leg
        && resolveUnitDelivery(plugin.capabilities.sessionBundle.units.model, leg).kind === 'native') return 'declared'
      return 'missing'
    },
    host: [
      'apps/desktop/electron/capability-bundle.ts',
      'apps/desktop/electron/engine-injection-contract.ts',
      'apps/desktop/electron/platform-envelope.ts',
      'apps/desktop/electron/model-access.ts',
      'apps/desktop/electron/sessionpage/sessionpage-platform-model.ts',
      'apps/desktop/electron/sessionpage/sessionpage-platform-hooks.ts',
      'apps/desktop/electron/sessionpage/sessionpage-platform-catalog.ts',
      'apps/desktop/electron/sessionpage/codex-pty-provisioning.ts',
      'apps/desktop/electron/session/main/core/agents/harness-model-catalog.ts',
      'apps/desktop/electron/session/main/core/agents/harness-model-catalog-wiring.ts',
      'packages/core/src/shared/agentModelSelection.ts',
      'packages/core/src/local/agent/modelAccess.ts',
    ],
  },
  {
    item: 'status', // 状态来源:CLI hooks、宿主适配器、ACP 更新
    declared: (plugin, surface) => {
      if (surface === 'acp') return plugin.capabilities.acp.kind === 'supported' ? 'declared' : 'unsupported'
      const tui = plugin.capabilities.sessionBundle.sessionpage.tui
      if (plugin.capabilities.hooks.kind !== 'none' || tui?.hostAdapter) return 'declared'
      return 'unsupported'
    },
    host: [
      'apps/desktop/electron/session/main/core/agent-hooks',
      'apps/desktop/electron/session/main/core/agent-status',
      'packages/core/src/local/agent/guestRegistration.ts',
      'apps/desktop/electron/session/main/core/sessions/provider-review-gate.ts',
    ],
  },
  {
    item: 'history', // 历史记录:在哪、什么格式、怎么读
    // 「读得到」以产品真读的那张表为准(时间线的 locate);插件的 coexistence.history 声明落后于它(#7380 起)。
    declared: (plugin) =>
      resolveSessionCoexistence(plugin.capabilities.sessionBundle.coexistence).history.kind === 'native'
        || sessionRecordHarnessForProvider(plugin.metadata.id) !== null
        ? 'declared'
        : 'unsupported',
    host: [
      'apps/desktop/electron/session/main/core/session-timeline',
      'packages/session-core/src/session-record',
      'packages/core/src/local/agent/transcriptSources',
      'packages/core/src/local/agent/runtimeInfo.ts',
      'packages/core/src/shared/types/transcripts.ts',
      'apps/desktop/electron/session/main/core/usage/token-readers',
      'apps/desktop/electron/session/main/core/sessions/fork-capture.ts',
      'apps/desktop/electron/session/main/core/sessions/fork-lineage.ts',
      'apps/desktop/electron/session/main/core/session-import',
      'apps/desktop/src/session/shared/core/session-import',
      'apps/desktop/electron/acp-session-store.ts',
    ],
  },
  {
    item: 'mcp', // MCP 配置
    declared: (plugin, surface) => {
      const leg = legOf(plugin, surface)
      if (!leg) return 'unsupported'
      return resolveUnitDelivery(plugin.capabilities.sessionBundle.units.mcp, leg).kind === 'native' ? 'declared' : 'unsupported'
    },
    host: [
      'apps/desktop/electron/session/main/core/mcp',
      'packages/session-core/src/mcp',
      'packages/session-core/src/agents/plugins/helpers/mcp.ts',
    ],
  },
  {
    item: 'delivery', // 投递:消息怎么送进这一家
    declared: (plugin, surface) => {
      const integration = plugin.capabilities.sessionBundle.sessionpage[surface]
      if (!integration) return legOf(plugin, surface) ? 'missing' : 'unsupported'
      return integration.messageTransport === 'none' ? 'unsupported' : 'declared'
    },
    host: [
      'apps/desktop/electron/main.ts',
      'apps/desktop/electron/sessionpage/codex-app-server-delivery.ts',
      'apps/desktop/electron/sessionpage/claude-session-delivery.ts',
      'apps/desktop/electron/sessionpage/opencode-serve-attach-delivery.ts',
      'apps/desktop/electron/sessionpage/session-injection.ts',
      'apps/desktop/electron/sessionpage/local-session-delivery.ts',
      'packages/session-core/src/agents/plugins/helpers/prompt-injection.ts',
      'apps/desktop/src/session/shared/prompt-injection.ts',
      'packages/session-runtime/src/acp-agents',
    ],
  },
  {
    item: 'install', // 安装检测与版本
    declared: (plugin) => (plugin.capabilities.hostDependency ? 'declared' : 'missing'),
    host: [
      'apps/desktop/electron/session/main/core/dependencies',
      'packages/session-core/src/host-dependencies',
      'apps/desktop/electron/session/main/core/agents/acp-bridge',
      'apps/desktop/electron/enginePidReap.ts',
    ],
  },
  {
    item: 'configRoot', // 配置根:用户自己那份在哪、咕咕托管的那份
    declared: (plugin) => {
      const bundle = plugin.capabilities.sessionBundle as { configRoot?: unknown; nativeHome?: unknown }
      return bundle.configRoot || bundle.nativeHome ? 'declared' : 'missing'
    },
    host: [
      'apps/desktop/electron/session/main/core/agents/codex-probe-trust-scrub.ts',
      'apps/desktop/electron/session/main/core/search/search-index-exclusions.ts',
      'apps/desktop/electron/session/main/core/agents/agent-home.ts',
      'packages/core/src/shared/assistantPolicy.ts',
      'apps/desktop/electron/assistant-home-prepare.ts',
    ],
  },
  {
    item: 'capabilities', // 能力声明:档位、共处各维
    declared: () => 'declared',
    // 只登记宿主里读能力声明的地方。插件侧的注册表(registry.ts)与一致性名单(conformance/)本来就要逐家点名,
    // 那正是端口要的位置,不算「宿主为这一家专门写的代码」。
    host: ['packages/session-core/src/agents/plugins/capabilities/support-tier.ts'],
  },
]

// ── 宿主侧「专门写给这一家」的字面量 ─────────────────────────────────────────────

function codeFiles(entry: string): string[] {
  const path = join(ROOT, entry)
  if (!statSync(path, { throwIfNoEntry: false })) return []
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path, { recursive: true })
    .map((name) => join(path, String(name)))
    .filter((file) => /\.(ts|tsx|mts|mjs)$/.test(file) && !/\.test\.|__fixtures__|\.d\.ts$/.test(file))
}

/** 去掉注释:注释里点名一家不是代码。字符串里的 `//`(URL)保留 —— 先把字符串整体跳过。 */
function stripComments(source: string): string {
  return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '')
}

const fileText = new Map<string, string>()
const textOf = (file: string): string => {
  let text = fileText.get(file)
  if (text === undefined) {
    text = stripComments(readFileSync(file, 'utf8'))
    fileText.set(file, text)
  }
  return text
}

/** 这一家在宿主代码里会被点名的样子。 */
function tokensFor(plugin: Plugin): RegExp {
  const id = plugin.metadata.id
  const names = [id]
  if (id === 'claude') names.push('claude-code')
  const dialect = findInjectionContract(id, 'tui')?.dialect ?? findInjectionContract(id, 'cui')?.dialect
  if (dialect) names.push(dialect)
  const quoted = names.map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
  const envPrefix = id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return new RegExp(`(['"\`])(?:${quoted})\\1|\\b${envPrefix}_[A-Z0-9_]+\\b|['"\`/]\\.${id}\\b`)
}

/**
 * 落在登记的宿主目录里、但字面量**不是** harness 分派的文件(相对仓根)→ 理由。字面量判据在这些文件上只会给出假阳性。
 * ⚠️ 只收「同一个词指的是别的东西」的文件;真按家分派的代码再丑也不许进这张表。
 */
const NOT_HARNESS_DISPATCH: Readonly<Record<string, string>> = {
  'apps/desktop/src/session/renderer/features/sessions/session-config/model-provider.ts':
    "按**模型名**(opus / sonnet / qwq / tongyi…)选厂商图标:'claude' / 'qwen' 是模型家族,与哪个 harness 在跑无关",
}

function specialCasedIn(plugin: Plugin, files: readonly string[]): string[] {
  const pattern = tokensFor(plugin)
  return files.filter((file) => pattern.test(textOf(file)))
}

// ── 矩阵 ─────────────────────────────────────────────────────────────────────

type Row = { id: string; cells: Record<string, Cell>; fixedIn: Record<string, string[]> }

function measure(): { rows: Row[]; counts: Record<Cell, number>; unassigned: Record<string, string[]> } {
  // 上架的各家,加上 owner 点名要进矩阵、但还在内测(withheld)的家 —— 注册表里有就按真插件量。
  const exposed = listUserExposedPlugins()
  const extra = EXTRA_ROWS.flatMap((id) => {
    const plugin = pluginRegistry.get(id)
    return plugin && !exposed.includes(plugin) ? [plugin] : []
  })
  const plugins = [...exposed, ...extra].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))
  const counts: Record<Cell, number> = { auto: 0, fixed: 0, unsupported: 0, missing: 0 }
  const rows: Row[] = []
  for (const plugin of plugins) {
    const row: Row = { id: plugin.metadata.id, cells: {}, fixedIn: {} }
    for (const { item, declared, host } of PORT) {
      const files = host.flatMap(codeFiles).filter((file) => !(relative(ROOT, file) in NOT_HARNESS_DISPATCH))
      const hits = specialCasedIn(plugin, files).map((file) => relative(ROOT, file))
      if (hits.length > 0) row.fixedIn[item] = hits
      for (const surface of SURFACES) {
        const offered = legOf(plugin, surface) !== null
        const state = offered ? declared(plugin, surface) : 'unsupported'
        const cell: Cell =
          state === 'unsupported' ? 'unsupported' : hits.length > 0 ? 'fixed' : state === 'declared' ? 'auto' : 'missing'
        row.cells[`${item}/${surface}`] = cell
        counts[cell] += 1
      }
    }
    rows.push(row)
  }
  for (const id of EXTRA_ROWS) {
    if (plugins.some((plugin) => plugin.metadata.id === id)) continue
    const row: Row = { id: `${id}(未合入 dev)`, cells: {}, fixedIn: {} }
    for (const { item } of PORT) for (const surface of SURFACES) {
      row.cells[`${item}/${surface}`] = 'missing'
      counts.missing += 1
    }
    rows.push(row)
  }
  // 登记之外的宿主文件里,谁还在点名哪一家 —— 不进矩阵,但必须看得见。
  const assigned = new Set(PORT.flatMap(({ host }) => host.flatMap(codeFiles)))
  const scanned = ['apps/desktop/electron', 'apps/desktop/src', 'packages/core/src', 'packages/session-core/src', 'packages/session-runtime/src', 'packages/session-ui/src']
    .flatMap(codeFiles)
    .filter((file) => !assigned.has(file))
  const unassigned: Record<string, string[]> = {}
  for (const plugin of plugins) {
    const hits = specialCasedIn(plugin, scanned).map((file) => relative(ROOT, file))
    if (hits.length > 0) unassigned[plugin.metadata.id] = hits
  }
  return { rows, counts, unassigned }
}

describe('harness adapter 端口矩阵', () => {
  const { rows, counts, unassigned } = measure()

  it('打印矩阵(读数)', () => {
    const columns = PORT.flatMap(({ item }) => SURFACES.map((surface) => `${item}/${surface}`))
    const mark: Record<Cell, string> = { auto: 'A', fixed: 'F', unsupported: '-', missing: '?' }
    const lines = [
      ['harness'.padEnd(18), ...PORT.map(({ item }) => item.slice(0, 11).padEnd(11))].join(' '),
      ...rows.map((row) =>
        [row.id.padEnd(18), ...PORT.map(({ item }) => SURFACES.map((s) => mark[row.cells[`${item}/${s}`]!]).join('').padEnd(11))].join(' '),
      ),
      `cells=${rows.length * columns.length} auto=${counts.auto} fixed=${counts.fixed} unsupported=${counts.unsupported} missing=${counts.missing}`,
    ]
    console.log(lines.join('\n'))
    console.log(JSON.stringify({ counts, fixedIn: Object.fromEntries(rows.map((r) => [r.id, r.fixedIn])), unassigned }, null, 2))
    expect(rows.length).toBeGreaterThan(0)
  })

  it('棘轮:auto 只涨,fixed / missing 只降', () => {
    expect(counts.auto).toBeGreaterThanOrEqual(baseline.auto)
    expect(counts.fixed).toBeLessThanOrEqual(baseline.fixed)
    expect(counts.missing).toBeLessThanOrEqual(baseline.missing)
  })

  it('判据会红:一个按 id 点名的宿主文件能被认出来(阳控)', () => {
    const claude = pluginRegistry.get('claude')!
    expect(specialCasedIn(claude, codeFiles('apps/desktop/electron/session/main/core/agents/harness-connections.ts'))).toHaveLength(1)
    // 阴控:只在注释里点名不算。
    expect(stripComments("// providerId === 'claude'\nconst x = 1")).not.toMatch(/claude/)
  })
})
