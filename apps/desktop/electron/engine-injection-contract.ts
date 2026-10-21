// @@@2503 引擎注入契约 —— 「平台额度这次要注到哪个进程、用什么载体、令牌活多久、这个 harness 会自己
// 点名几个模型」这四件事,一个引擎一格、一个界面一格,写在一张表里。
//
// 为什么需要这张表:同一个引擎在两个界面(终端会话 / Chat UI)上的注入拓扑**根本不是一回事**,而此前
// 这个差别只存在于各处的 if 里:
//
// - claude 的 argv 就是它本体的 argv(pty 里跑的就是 claude),codex 的 `-c` 却属于它背后的 app-server ——
//   挂到 TUI 客户端上什么都钉不住。这一条曾以 `modelArgsTargetVisibleClient(dialect)` 的形式散在物化层。
// - codex 的令牌在 app-server **spawn 那一刻**被烤进它的进程环境,换不了值。所以重开会话时重新签发
//   = 先撤销活着的那个令牌 → 此后每一轮 401(#2503 台账 3 号,22a6833ff 修)。claude TUI 恰恰相反:
//   进程随会话重开而重建,必须签新的。
// - Claude Code 会**自己**发起后台小模型请求(会话标题、命令描述),打的是它内置的 Haiku 模型 id。
//   平台令牌在网关上只白名单了一个模型 → 那些请求 403 裸落终端(台账 1 号,829c03a69 修)。
//   也就是说 claude 这一格的「模型槽位」是两个,不是一个;codex / opencode 是一个。
//
// 三条都是同一类知识:**这个引擎的进程拓扑**。散在 if 里的时候,每接一个新界面就要把它们重新发现一遍
// (而发现的方式是线上踩坑)。列成声明之后,新界面照着表接线,漏接的格子是表上一行显眼的 `wired: false`,
// 而不是一次静默的「界面写 A、实际跑 B」。
//
// 声明住在各家插件里(`impl/<家>/platform.ts`,契约见 session-core `HarnessPlatform`),这里只读声明、
// 摊成「一个引擎 × 一个界面一格」给调用方查。查不到就是查不到,调用方各自决定要不要因此停下。

import type {
  CredentialCarrier,
  HarnessWireProtocol,
  InjectionProcess,
  InjectionSurface,
  ModelConfigDialect,
  PlatformSurfaceInjection,
} from '@gugu/session-core/agents/plugins'
import { guguCatalogReasonCode } from '@gugu/session-core/session-record/contract'
import { pluginRegistry } from '@gugu/session-plugins/agents'
import type { ModelAccessProtocol } from '@gugu/core/shared/agentModelSelection'
import { createLogger } from './lib/logger'

export type {
  CredentialCarrier,
  CredentialSink,
  InjectionProcess,
  InjectionSurface,
  ModelSlot,
  TokenLifetime,
  TokenReuseProbe,
} from '@gugu/session-core/agents/plugins'

/**
 * 插件的协议词表与 core 的 `ModelAccessProtocol` 必须逐字相同:core 看不见插件、插件看不见 core,
 * 桌面层是唯一同时看得见两边的地方。哪边多一个成员,这两行就编不过。
 */
type MustBeNever<T extends never> = T
export type _WireProtocolMatchesCore = MustBeNever<Exclude<HarnessWireProtocol, ModelAccessProtocol>>
export type _CoreProtocolMatchesWire = MustBeNever<Exclude<ModelAccessProtocol, HarnessWireProtocol>>

export interface EngineInjectionContract extends PlatformSurfaceInjection {
  engineId: string
  surface: InjectionSurface
  /** 这个引擎接受模型指定的方言(插件 `platform.dialect`,引擎级)。 */
  dialect: ModelConfigDialect
}

function contracts(): EngineInjectionContract[] {
  return pluginRegistry.getAll().flatMap((plugin) => {
    const platform = plugin.capabilities.sessionBundle.platform
    if (platform.kind !== 'supported') return []
    return (['tui', 'cui'] as const).flatMap((surface) => {
      const injection = platform.injection[surface]
      return injection
        ? [{ engineId: plugin.metadata.id, surface, dialect: platform.dialect, ...injection }]
        : []
    })
  })
}

/**
 * 这家线上发的协议(插件 `platform.wireProtocol`)。null = 这家没接平台模型,或者不是注册过的插件 ——
 * 于是永远不被签发中转令牌、composer 里一条平台模型都列不出来。
 */
export function platformProtocolForEngine(engineId: string): ModelAccessProtocol | null {
  const platform = pluginRegistry.get(engineId)?.capabilities.sessionBundle.platform
  return platform?.kind === 'supported' ? platform.wireProtocol : null
}

/** 表上的全部声明(测试与巡检用;❌ 别拿它当引擎目录)。 */
export function engineInjectionContracts(): readonly EngineInjectionContract[] {
  return contracts()
}

/** 这一格的契约,查不到返回 null(插件引擎本来就不在表里,见文件抬头)。 */
export function findInjectionContract(
  engineId: string,
  surface: InjectionSurface,
): EngineInjectionContract | null {
  return contracts().find((entry) => entry.engineId === engineId && entry.surface === surface) ?? null
}

/**
 * 这个引擎**怎么接收模型指定** —— 方言,按引擎(不按 surface):surface 只决定投递到哪个进程,
 * 不改变这家怎么被指定模型。真值是插件的 `platform.dialect`(从前寄存在一张已退役的引擎表
 * 里,插件注册的引擎一行都没有 ⇒ 选咕咕模型就死在
 * `unknown or disabled engine`,owner 2026-08-26 在 qwen 上撞到)。
 */
export function injectionDialectForEngine(engineId: string): ModelConfigDialect | null {
  const platform = pluginRegistry.get(engineId)?.capabilities.sessionBundle.platform
  return platform?.kind === 'supported' ? platform.dialect : null
}

/**
 * 这一格的契约,查不到就抛。
 *
 * 用在「已经确定这次要走平台额度」之后:表上没有这一格,意味着我们不知道凭据该落到哪个进程 ——
 * 继续下去就是把这一轮交给环境里恰好存在的用户 Key,而界面上写着咕咕的模型。
 */
export function requireInjectionContract(
  engineId: string,
  surface: InjectionSurface,
): EngineInjectionContract {
  const contract = findInjectionContract(engineId, surface)
  if (!contract?.wired) {
    // 界面只说「咕咕模型尚未对这个 Agent 开通」(#7103 原因码),哪一格缺了只进日志。
    const detail = `${engineId}/${surface}: platform injection contract is ${contract ? 'not wired' : 'undeclared'}`
    createLogger('engine-injection-contract').warn({ engineId, surface }, detail)
    throw new Error(guguCatalogReasonCode('not-routable'), { cause: new Error(detail) })
  }
  return contract
}

/**
 * 这次平台注入能不能**整份骑在适配器进程环境上**送达。
 *
 * ACP 腿上的注入信封只有三种:claude 的会话 `_meta`、codex 的 adapter-spawn 载荷,以及能力注入
 * 那条腿已有的 `capabilitySpawnEnv` —— 它在 plugin-host 的 `buildAcpSpawn` 里最后叠进适配器进程
 * 环境,而它的存在本身又让这条会话拿到一个 conversation 私有的适配器进程(session-manager 的连接
 * key),正是本表 `acpAdapterProcess` 那档生命期要的东西。这个谓词只回答一件事:第三种够不够。
 *
 * 三道**互相独立**的闸,少一道就会误伤 codex 那类引擎:
 *
 * 1. **表上的声明**:凭据 sink 必须全部是 `(acpAdapter, processEnv)`。codex 的 cui 格还声明了
 *    `spawnEnvConfigDocument`,claude 声明 `acpSessionMeta` + `settingsDocumentFile`,都在这一闸出局。
 * 2. **这次会话没有要落盘的 settings 文档**。文档路径这条信封根本带不走(它得进 `_meta` 或 argv),
 *    带走一半 = 模型钉住了、凭据没到,比不注入更糟。
 * 3. **物化出来的 env 里同时出现这次的中转地址与令牌**。这是行为判据、不看名字。
 *    模型目录探针的占位凭据(`buildProbePlatformCredentials`)走的也是这个分派。codex 的模型钉扎走 argv(`-c model=…`),
 *    它的 `spawnEnv` 是空的,所以哪天有人把第 1 闸的声明改宽,这一闸照样拦得住。
 *
 * ⚠️ 三闸都过**不等于**可以省掉方言分支的顺序:调用方仍必须先让各家自己的分支认领,再问这个谓词。
 *    它回答「这一格能不能用第三种信封」,不回答「这一格该用哪种」。
 *
 * 令牌用**子串**匹配而不是整值相等:opencode 系把令牌包在一份 JSON 配置文档里、整份塞进一个环境
 * 变量,那同样是「凭据真的进了适配器进程环境」。整值相等会把它们判成送不到,而它们送得到。
 */
export function platformRidesAdapterProcessEnv(
  contract: EngineInjectionContract,
  launch: {
    spawnEnv: Record<string, string>
    settingsDocumentPath: string | null
    platformProvider: { baseUrl: string; apiKey: string } | null
    /**
     * 这家方言按协议表拿到的中转原话(宿主 `buildAcpModelCapability` 写进声明的那份)。
     * 有它时第三闸对的是**它的值**,而不是 `platformProvider.baseUrl` —— 后者是 OpenAI 面带 `/v1`
     * 的形状,gemini 的 env 里出现的是裸根,拿 `/v1` 去对永远对不上,于是整家被判成
     * 「送不进适配器进程环境」、startSession 抛「方言无法送达」(#4700 B3/B4 撞到)。
     * 没有它(OpenAI 面方言)照旧对 baseUrl + apiKey。
     */
    platformSettingsEnv?: Readonly<Record<string, string>> | null
  },
): boolean {
  const sinks = contract.credentialSinks
  if (sinks.length === 0) return false
  if (!sinks.every((sink) => sink.process === 'acpAdapter' && sink.carrier === 'processEnv')) {
    return false
  }
  if (launch.settingsDocumentPath !== null) return false
  if (!launch.platformProvider) return false
  const values = Object.values(launch.spawnEnv)
  const carries = (needle: string): boolean => values.some((value) => value.includes(needle))
  const needles = launch.platformSettingsEnv && Object.keys(launch.platformSettingsEnv).length > 0
    ? Object.values(launch.platformSettingsEnv)
    : [launch.platformProvider.baseUrl, launch.platformProvider.apiKey]
  return needles.every(carries)
}

/** 这一格是否把凭据送进指定的 (进程, 载体)。 */
export function hasCredentialSink(
  contract: EngineInjectionContract,
  process: InjectionProcess,
  carrier: CredentialCarrier,
): boolean {
  return contract.credentialSinks.some((sink) => sink.process === process && sink.carrier === carrier)
}

/**
 * 重开这条会话时,该复用已签发的令牌,还是签一个新的。
 *
 * 探针的两个输入分开传:`inferenceProcessLive` 是去问那个独立进程,`heldRecordExists` 是我们自己的
 * 签发记录。`liveInferenceProcess` 档两个都要 —— 进程活着但记录没了(electron 重启)时手里根本没有
 * 可复用的东西,那就该按新会话签发。
 */
export function shouldReuseHeldPlatformToken(
  contract: EngineInjectionContract | null,
  probes: { inferenceProcessLive: boolean; heldRecordExists: boolean },
): boolean {
  if (!contract) return false
  switch (contract.tokenReuseProbe) {
    case 'none':
      return false
    case 'liveInferenceProcess':
      return probes.inferenceProcessLive && probes.heldRecordExists
    case 'heldRecord':
      return probes.heldRecordExists
  }
}

/**
 * 这一格需不需要一份 0600 的 settings 文档。
 *
 * 只有 claude 那一档需要:用户 `~/.claude/settings.json` 的 `env` 块在启动时被写进进程环境,压得住
 * 我们导出的一切,只有 `--settings` 那一层压得住它。两个界面都要 —— 终端会话把路径挂上 argv,
 * Chat UI 把路径放进 `_meta` 交给适配器,同一份文档、同一个理由。
 */
export function needsSettingsDocument(contract: EngineInjectionContract | null): boolean {
  return contract?.credentialSinks.some((sink) => sink.carrier === 'settingsDocumentFile') ?? false
}

/**
 * 这份 settings 文档该不该以 `--settings` 挂到可见客户端的 argv 上。
 *
 * Chat UI 那一格是 false:那条路上咕咕不 spawn 可见进程,`--settings` 对 ACP 适配器是个不认识的参数,
 * 路径要走 `_meta` 才到得了它背后真正读设置的那个 claude 进程。
 */
export function settingsDocumentGoesOnVisibleClientArgv(
  contract: EngineInjectionContract | null,
): boolean {
  return contract ? hasCredentialSink(contract, 'visibleClient', 'settingsDocumentFile') : false
}

/**
 * 这个方言的模型参数该不该挂到**可见客户端自己的 argv** 上。
 *
 * 从契约推,而不是再写一遍 if:终端界面上,只有「凭据经 settingsDocumentFile 落到 visibleClient」的那一格
 * 才有属于可见进程的模型 argv。codex 的 `-c` 属于它的 app-server,挂到 TUI 上什么都钉不住 —— 这道 gate
 * 就是防止那条通道退化成「什么 argv 都往可见进程上挂」。
 */
export function dialectModelArgsTargetVisibleClient(dialect: ModelConfigDialect | null): boolean {
  if (!dialect) return false
  return contracts().some(
    (contract) =>
      contract.surface === 'tui'
      && contract.dialect === dialect
      && hasCredentialSink(contract, 'visibleClient', 'settingsDocumentFile'),
  )
}
