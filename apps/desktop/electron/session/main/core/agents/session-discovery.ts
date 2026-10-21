// @@@4972 session_list_harnesses / session_list_models 的实现 —— spec session-agent-selection。
//
// 本模块的**唯一职责**是把「用户新建 agent 时看得到的那份可用配置」原样转述给 agent。
// ❌ 它不得自己判断什么可用:harness 那道闸是 `listPlugins()`(产品自己的唯一收口),
// 平台模型那一组是宿主的 `sessionpagePlatformCatalog`(composer 那条 IPC 调的同一个函数)。
// 复制任何一条判据出来,漂的方向必然是「工具说可以、产品说不行」—— 而 agent 是拿着工具的返回值
// 去 spawn 的,那时才发现选了一个用户根本选不到的东西。

import { GUGU_CATALOG_EMPTY_REASON, guguCatalogReasonCode } from '@gugu/session-core/session-record/contract'
import type { CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins'
import type { PluginRegistry } from '@gugu/session-shared/plugins'
import { resolveActiveInstallation, type DependencyState, type HostDependency } from '@gugu/session-core/deps/runtime'
import { platformNamespaceCollisions, platformOptionId } from '@shared/platform-model-id'
import { listPlugins } from './plugin-registry'
import {
  getPlatformModelCatalogResolver,
  type PlatformModelCatalogSnapshot,
} from './platform-model-catalog-hook'
import { log } from '@main/lib/logger'
import type {
  HarnessCatalogState,
  HarnessModelChoice,
} from './harness-model-catalog'

/** 会话形态。`session_list_models` 与 `session_spawn` 用同一套词,默认也是同一条(继承 caller)。 */
export type SessionTransport = 'acp' | 'pty'

/** The host facts exposed by session_list_harnesses. Paths and credentials are intentionally absent. */
export type SessionHarness = {
  id: string
  name: string
  description: string
  status: 'available' | 'missing' | 'error'
  version: string | null
  surfaces: SessionTransport[]
  /**
   * 起不来的腿 → 启动那道闸的原话(如版本低于这一家声明的下界)。全部能起时没有这个字段。
   * 与 `session_spawn` 拒绝时报的是同一句:两边问的是同一个函数。
   */
  blocked?: Partial<Record<SessionTransport, string>>
  /** 至少有一条腿过了启动那道闸。 */
  spawnable: boolean
}

/**
 * 一条可选模型。`id` **直接就是** `session_spawn` 的 `model` 取值 —— agent 不需要在 list 与 spawn
 * 之间做任何翻译或拼装。
 */
export type SessionModelChoice = HarnessModelChoice & {
  /**
   * 谁的额度。与 spawn 返回快照的 `model.source` 是同一套词,所以派活的一方读到 `gugu`,
   * 就知道 child 会按积分计费。
   *
   * - `harness` —— 这家 harness 自己的模型,用户自己的 Key(BYOK)。`id` 是 harness 原生 id。
   * - `gugu`    —— 咕咕平台模型,按积分计费。`id` 带 `platform:` 前缀。
   */
  source: 'harness' | 'gugu'
  /** 相对倍率(display-only),只有 `gugu` 条目可能有;取不到就没有这个字段。 */
  credit_multiplier?: number
  /**
   * 这个模型认的推理档(目录逐模型下发,#6447),只有 `gugu` 条目有;目录没有这条事实就没有这个字段。
   * 手机新建页据此与 harness 的档位取交集 —— 与桌面 composer 同一条规则。
   */
  reasoning_efforts?: string[]
  /**
   * 这个用户的会员档用不了它、要开会员(#7056),只有 `gugu` 条目可能有;能用就没有这个字段。
   * agent 读到它就别拿它去 `session_spawn`(会被当场拒);手机清单据此标「会员」、点它去网页开通。
   */
  requires_membership?: true
  /**
   * 用户在设置「模型」页关掉了它(#7056):手机新建页的清单不列它。只管人看的下拉 ——
   * agent 照样可以拿它 `session_spawn`(与 Cursor 的 Settings › Models 同一语义)。没关就没有这个字段。
   */
  hidden?: true
}

/** The host facts exposed by session_list_models. */
export type SessionModelCatalog = {
  harness_id: string
  /** 问的是哪条腿 —— 平台那一组按 provider × transport 算(qoder 的 acp 腿没有,tui 腿有)。 */
  transport: SessionTransport
  /** 两组并成一份,每条自报 source。顺序:harness 自家在前,咕咕的在后(与 composer 下拉同序)。 */
  models: SessionModelChoice[]
  /** harness 自家目录当前选中的那个(平台模型不参与这个字段)。 */
  selected: string | null
  /** 推理档 —— 引擎的固有属性,没登录也有(`ready` / `auth-required` 两态都带);其它态空数组。 */
  efforts: HarnessModelChoice[]
  selected_effort: string | null
  /** harness 自家那一组的来源与探测状态 —— 空列表要说得出是为什么。 */
  harness_catalog: {
    source: 'live-acp' | 'declared' | 'none'
    state: HarnessCatalogState['kind']
    reason?: string
    auth_methods?: HarnessModelChoice[]
  }
  /** 咕咕那一组在不在场;不在场时带上产品自己那句定性原话。 */
  gugu_catalog: { available: true } | { available: false; reason: string | null }
}

/** Whether a model id is an explicitly advertised harness-owned choice. */
export function isHarnessModelChoice(
  catalog: Pick<SessionModelCatalog, 'models'>,
  modelId: string,
): boolean {
  return catalog.models.some((model) => model.source === 'harness' && model.id === modelId)
}

export type SessionDiscoveryDeps = {
  /**
   * **产品提供给用户新建的**那一份 harness,不是整张注册表。
   * `plugin-registry.ts` 的 `listPlugins()` 是它唯一的收口(支持档 ∧ 咕咕集成档)。
   */
  listOffered: () => CLIAgentPluginProvider[]
  /**
   * 按 id 查表 —— **照常解析所有已注册的家**,不过上面那道闸。
   * 理由与 `plugin-registry.ts` 抬头写的一样:闸挡的是新建入口,不是查表;
   * 已经在用某家的会话必须继续读得出它的模型目录。
   */
  get: PluginRegistry<CLIAgentPluginProvider>['get']
  manager: {
    get(id: string): DependencyState | undefined
    getAll(): Map<string, DependencyState>
    /** 这一家选中的是哪一份(设置 → 智能体);行里的版本报的是这一份,与启动跑的、资源库显示的是同一份。 */
    getHostDependency(id: string): HostDependency | undefined
  }
  ensureProbed: () => Promise<void>
  /** 启动那道闸本身(`assertLocalHarnessLaunchable`):起不来就抛,原话就是启动时那句。 */
  assertLaunchable: (pluginId: string, transport: SessionTransport) => Promise<void>
  getModelCatalog: (
    pluginId: string,
    /** 目录替哪条腿读 —— 两条腿的配置根可能不同(#6246)。 */
    options: { leg: 'acp' | 'tui'; harnessVersion?: string | null; force?: boolean },
  ) => Promise<HarnessCatalogState>
  /** 咕咕平台模型那一组;宿主没装钩子 = 这一组缺席。 */
  getPlatformCatalog: (
    pluginId: string,
    surface: 'acp' | 'tui',
  ) => Promise<PlatformModelCatalogSnapshot | null>
}

function surfaceNames(provider: CLIAgentPluginProvider): SessionTransport[] {
  const sessionpage = provider.capabilities.sessionBundle.sessionpage
  const surfaces: SessionTransport[] = []
  if (sessionpage['acp']) surfaces.push('acp')
  if (sessionpage['tui']) surfaces.push('pty')
  return surfaces
}

function statusOf(state: DependencyState | undefined): SessionHarness['status'] {
  // A manager that has not probed yet is resolved by ensureProbed before this function runs.
  // Keep an absent row conservative: it is not spawnable and is reported as missing.
  return state?.status ?? 'missing'
}

/** transport(产品语言)→ session surface(能力包语言)。两套词在别处已经这么对,这里只是转一次。 */
export function surfaceOfTransport(transport: SessionTransport): 'acp' | 'tui' {
  return transport === 'acp' ? 'acp' : 'tui'
}

/** Build the canonical harness list — the same offer the user's own engine picker shows. */
export async function listHarnessesFrom(deps: SessionDiscoveryDeps): Promise<SessionHarness[]> {
  await deps.ensureProbed()
  const rows = deps
    .listOffered()
    .map((provider) => ({ provider, surfaces: surfaceNames(provider) }))
    .filter((row) => row.surfaces.length > 0)
  return Promise.all(rows.map(async ({ provider, surfaces }) => {
    const id = provider.metadata.id
    const state = deps.manager.get(id)
    const host = deps.manager.getHostDependency(id)
    const inUse = host ? resolveActiveInstallation(host.installations, host.used) : undefined
    const status = statusOf(state)
    // 「能不能起」只问启动那道闸 —— 下界、可执行文件、探针都是它的;这里 ❌ 另比版本。
    const blocked: Partial<Record<SessionTransport, string>> = {}
    if (status === 'available') {
      await Promise.all(surfaces.map(async (transport) => {
        try {
          await deps.assertLaunchable(id, transport)
        } catch (error) {
          blocked[transport] = error instanceof Error ? error.message : String(error)
        }
      }))
    }
    const startable = surfaces.filter((transport) => !blocked[transport])
    return {
      id,
      name: provider.metadata.name,
      description: provider.metadata.description,
      status,
      version: inUse?.version ?? state?.version ?? null,
      surfaces,
      ...(Object.keys(blocked).length ? { blocked } : {}),
      spawnable: status === 'available' && startable.length > 0,
    }
  }))
}

function staticModelChoices(provider: CLIAgentPluginProvider): HarnessModelChoice[] {
  const models = provider.capabilities.models as {
    kind: string
    modelOptions?: Record<string, { name?: unknown; description?: unknown }>
  }
  if (models.kind !== 'selectable' || !models.modelOptions) return []
  return Object.entries(models.modelOptions).map(([id, option]) => ({
    id,
    name: typeof option.name === 'string' ? option.name : id,
    ...(typeof option.description === 'string' ? { description: option.description } : {}),
  }))
}

/** harness 自家那一组,以及它为什么是这些。 */
function harnessGroup(
  provider: CLIAgentPluginProvider,
  catalog: HarnessCatalogState,
): {
  models: HarnessModelChoice[]
  selected: string | null
  efforts: HarnessModelChoice[]
  selectedEffort: string | null
  meta: SessionModelCatalog['harness_catalog']
} {
  if (catalog.kind === 'ready') {
    return {
      models: catalog.models,
      selected: catalog.selected,
      efforts: catalog.efforts,
      selectedEffort: catalog.selectedEffort,
      meta: { source: 'live-acp', state: catalog.kind },
    }
  }

  // ACP-unsupported harnesses use their declared model capability as the only source.
  // Installed/auth/error states deliberately return no fabricated options.
  if (catalog.kind === 'unsupported') {
    return {
      models: staticModelChoices(provider),
      selected:
        provider.capabilities.models.kind === 'selectable'
          ? provider.capabilities.models.defaultModelId ?? null
          : null,
      efforts: [],
      selectedEffort: null,
      meta: { source: 'declared', state: catalog.kind },
    }
  }

  return {
    models: [],
    selected: null,
    // 没登录也有档位:档位是引擎的固有属性(见 HarnessCatalogState 的 auth-required 抬头)。
    efforts: catalog.kind === 'auth-required' ? catalog.efforts : [],
    selectedEffort: catalog.kind === 'auth-required' ? catalog.selectedEffort : null,
    meta: {
      source: 'none',
      state: catalog.kind,
      ...(catalog.kind === 'unavailable' ? { reason: catalog.reason } : {}),
      ...(catalog.kind === 'auth-required' ? { auth_methods: catalog.authMethods } : {}),
    },
  }
}

/**
 * 咕咕那一组。宿主没装钩子(测试、或宿主还没 boot 完)= 这一组缺席,理由为 null ——
 * 我们**编不出**用户看得懂的原因,只有宿主答上来了才有话可说(与 composer 那侧同一口径)。
 *
 * ⚠️ **解析器抛了也只让这一组缺席**,❌ 不连累 harness 自家那一组。宿主那侧的合同原话是
 * 「harness 自家模型那一组必须照常可选,平台分组读不出来只是少一组」——两侧要说同一句话。
 * `reason` 只装原因码(`guguCatalogReasonCode`,各端翻译);抛出的原话进日志 —— 这一格会被转给
 * 别的机器、画进它的新建框,原文进去就是英文诊断直接给人看(#6264)。
 */
export async function platformGroupFrom(
  deps: Pick<SessionDiscoveryDeps, 'getPlatformCatalog'>,
  harnessId: string,
  transport: SessionTransport,
): Promise<{ models: SessionModelChoice[]; meta: SessionModelCatalog['gugu_catalog'] }> {
  let snapshot: PlatformModelCatalogSnapshot | null
  try {
    snapshot = await deps.getPlatformCatalog(harnessId, surfaceOfTransport(transport))
  } catch (error) {
    log.warn('[session-discovery] platform catalog resolver failed', { harnessId, transport, error: String(error) })
    return { models: [], meta: { available: false, reason: guguCatalogReasonCode('service-unavailable') } }
  }
  // 两种「空」各说各的原因:一个说不出原因的空组,在界面上只能落成一个英文占位词,人和 agent 都没法据此行动。
  if (!snapshot) return { models: [], meta: { available: false, reason: guguCatalogReasonCode('host-not-ready') } }
  if (snapshot.models.length === 0) {
    return {
      models: [],
      meta: { available: false, reason: snapshot.catalogError ?? GUGU_CATALOG_EMPTY_REASON },
    }
  }
  return {
    models: snapshot.models.map((model) => ({
      id: platformOptionId(model.id),
      name: model.displayName,
      source: 'gugu' as const,
      ...(model.creditMultiplier !== null ? { credit_multiplier: model.creditMultiplier } : {}),
      ...(model.reasoningEfforts ? { reasoning_efforts: [...model.reasoningEfforts] } : {}),
      ...(model.requiresMembership ? { requires_membership: true as const } : {}),
      ...(model.hidden ? { hidden: true as const } : {}),
    })),
    meta: { available: true },
  }
}

/**
 * harness 自家的 id 一旦以 `platform:` 开头,就会在合并后的命名空间里冒充咕咕条目 ——
 * 症状是**「以为选了自己的模型,实际按积分计费」**。
 *
 * ⚠️ **判定不在这里** —— 它住在 `@shared/platform-model-id` 的 `platformNamespaceCollisions`,
 * composer 那条面(`sanitizeHarnessModelOptions`)调的是同一个函数。这套 id 空间被物化了两次,
 * 但判定只有一处:❌ 本文件不许照着再写一份 `startsWith`,那正是本模块抬头禁止的
 * 「为 MCP 复制一份判据」,而复制出来的那份会漂。
 *
 * 这里只决定**怎么报**:这些 id 来自外部 harness 进程(或它背后的中转网关),报了这种名字谁也
 * 改不了它 ⇒ ❌ 不抛,记一条并丢掉。宁可少一个模型可选,也不让它顶着平台条目的身份被选中 ——
 * 与那侧对「外部来源」的处置逐字相同。
 */
function withoutPlatformNamespaceCollisions(
  models: HarnessModelChoice[],
  harnessId: string,
): HarnessModelChoice[] {
  const offending = new Set(platformNamespaceCollisions(models.map((model) => model.id)))
  if (offending.size === 0) return models
  log.warn('harness model ids collide with the platform option prefix; dropping them', {
    harnessId,
    ids: [...offending],
  })
  return models.filter((model) => !offending.has(model.id))
}

/** Resolve one harness's model catalog, preserving the catalog's explicit state semantics. */
export async function listModelsFrom(
  deps: SessionDiscoveryDeps,
  harnessId: string,
  options: { force?: boolean; transport: SessionTransport },
): Promise<SessionModelCatalog> {
  await deps.ensureProbed()
  const provider = deps.get(harnessId)
  if (!provider) throw new Error(`Unknown harness '${harnessId}'`)

  const version = deps.manager.get(harnessId)?.version ?? null
  const [catalog, platform] = await Promise.all([
    deps.getModelCatalog(harnessId, {
      leg: surfaceOfTransport(options.transport),
      harnessVersion: version,
      ...(options.force ? { force: true } : {}),
    }),
    platformGroupFrom(deps, harnessId, options.transport),
  ])
  const harness = harnessGroup(provider, catalog)

  return {
    harness_id: harnessId,
    transport: options.transport,
    models: [
      ...withoutPlatformNamespaceCollisions(harness.models, harnessId).map((model) => ({
        ...model,
        source: 'harness' as const,
      })),
      ...platform.models,
    ],
    selected: harness.selected,
    efforts: harness.efforts,
    selected_effort: harness.selectedEffort,
    harness_catalog: harness.meta,
    gugu_catalog: platform.meta,
  }
}

/**
 * 这一家这条腿在本机起不起得来 —— **就是**启动时那道闸,不是它的复刻:
 * 聊天腿直接调 ACP 起进程用的 `resolveLocalAcpSpawnContext`;终端腿按终端启动那样解析可执行文件
 * (`role: 'tui'`),再过 `resolveSessionRuntimeCompatible`(local-session.ts 的同一个调用)。
 * codex 的终端腿另有 app-server 那一格下界(codex-app-server-delivery.ts 起 app-server 前过的那道),一并过。
 * 起不来就抛,原话与启动失败时界面上那句相同。`session_list_harnesses` 与 `session_spawn` 都只问它。
 */
export async function assertLocalHarnessLaunchable(
  pluginId: string,
  transport: SessionTransport,
): Promise<void> {
  const { resolveLocalAcpSpawnContext, localLaunchProbeContext } = await import('../acp/transport/local-acp-process-host')
  if (transport === 'acp') {
    await resolveLocalAcpSpawnContext(pluginId)
    return
  }
  const [{ getPlugin }, { resolveLocalAgentRunContext }, { resolveSessionRuntimeCompatible }, { diskFileStamp, diskWindowsShimReader }] =
    await Promise.all([
      import('./plugin-registry'),
      import('./agent-run-context'),
      import('./session-runtime-compatibility'),
      import('@gugu/session-core/exec'),
    ])
  const descriptor = getPlugin(pluginId).capabilities.sessionBundle
  const runContext = await resolveLocalAgentRunContext(pluginId, { role: 'tui' })
  if (runContext.cli.kind === 'unresolved') throw new Error(runContext.cli.message)
  const surfaces = descriptor.surfaces.includes('app-server') ? (['tui', 'app-server'] as const) : (['tui'] as const)
  for (const surface of surfaces) {
    await resolveSessionRuntimeCompatible({
      providerId: pluginId,
      surface,
      descriptor,
      executable: runContext.cli.path,
      executionContext: localLaunchProbeContext,
      runtimeExecutable: runContext.runtimeExecutable,
      windowsShimReader: diskWindowsShimReader,
      fileStamp: diskFileStamp,
    })
  }
}

/** Production dependency assembly. Kept lazy so importing tool contracts does not boot Electron services. */
export async function listLocalHarnesses(): Promise<SessionHarness[]> {
  const deps = await loadDesktopDiscoveryDeps()
  return listHarnessesFrom(deps)
}

export async function listLocalModels(
  harnessId: string,
  options: { force?: boolean; transport: SessionTransport },
): Promise<SessionModelCatalog> {
  const deps = await loadDesktopDiscoveryDeps()
  return listModelsFrom(deps, harnessId, options)
}

/**
 * 只要咕咕那一组 —— 给 `session_spawn` 校验一个 `platform:` 取值用。
 *
 * ⚠️ 刻意**不**走 `listLocalModels`:那条路会先 `ensureProbed()`(全机依赖探测)、再对 harness 起一次
 * 活的 ACP `session/new` 冷启(实测光 boot `mimo` 就 3.8s)。而校验一个平台 id **一样都用不到**,
 * spawn 那一侧还背着 3s 的动作预算。要什么问什么。
 */
export async function listLocalPlatformModels(
  harnessId: string,
  transport: SessionTransport,
): Promise<{ models: SessionModelChoice[]; meta: SessionModelCatalog['gugu_catalog'] }> {
  const deps = await loadDesktopDiscoveryDeps()
  return platformGroupFrom(deps, harnessId, transport)
}

/**
 * 这家 harness 目录的**原始四态**(等待版探测,与 listLocalModels 同一份缓存)—— 手机新建页算推理档要它:
 * 桌面 composer 拿的也是这一份四态,再经 shared 的 resolveCreateEfforts 合成。❌ 不从 SessionModelCatalog 反推:
 * 那份已经压平,分不出 unsupported(该用插件静态表)与 ready-但-空。
 */
export async function probeHarnessCatalogState(
  harnessId: string,
  transport: SessionTransport,
): Promise<HarnessCatalogState> {
  const deps = await loadDesktopDiscoveryDeps()
  await deps.ensureProbed()
  const version = deps.manager.get(harnessId)?.version ?? null
  return deps.getModelCatalog(harnessId, { leg: surfaceOfTransport(transport), harnessVersion: version })
}

async function loadDesktopDiscoveryDeps(): Promise<SessionDiscoveryDeps> {
  // ❌ 不再动态 import `./controller`：它唯一的用处是 `agentsController.modelCatalog`，
  //    而这条路刻意改用等待版（理由见下面 `getModelCatalog`）。留着那个 import 会把整条
  //    controller 依赖图拖进来，只为一个已经不用的符号。
  const [{ pluginRegistry }, dependencyManagers, { wireHarnessModelCatalog }] = await Promise.all([
    import('@gugu/session-plugins/agents'),
    import('../dependencies/dependency-managers'),
    import('./harness-model-catalog-wiring'),
  ])
  // ⚠️ 探针的「怎么起进程」是注入的,默认解析器恒答 null ⇒ 每家都被判成 `unsupported` ⇒ 退回插件
  //    静态表。桌面 composer 的 `modelCatalog` RPC 每次都先 wire 一遍才探,所以它从没撞上;而这条路
  //    (手机新建页 / session_spawn)在这台机器的 composer 从没被打开过时先到,拿到的就是一张
  //    过时的静态表(claude 的 `claude-sonnet-5` 在真会话里根本不存在 ⇒ set_config 读回 `sonnet`
  //    对不上,会话起不来;2026-09-15 owner 真机撞到)。幂等,重复调用无代价。
  wireHarnessModelCatalog()
  return {
    listOffered: listPlugins,
    get: (id) => pluginRegistry.get(id),
    manager: dependencyManagers.localDependencyManager,
    ensureProbed: async () => {
      await dependencyManagers.ensureAgentDependenciesProbed(dependencyManagers.localDependencyManager)
    },
    assertLaunchable: assertLocalHarnessLaunchable,
    /**
     * ⚠️ 这里**刻意不是** `agentsController.modelCatalog`（那条 RPC 是给 composer 的）。
     *
     * `modelCatalog` 自 2026-08-26 起**不等 harness 进程**（`lookupHarnessModelCatalog`）——
     * 手上有什么先答什么，该探的在后台探，回包带 `refreshing` 让渲染层继续盯。那是为了
     * composer：owner 实测切到 mimocode 要 30s 干等，用户不该为一次冷启买单。
     *
     * 但这条路不是界面，是**给会话挑 spawn 模型**。在这里"先给陈的"会静默变成"挑不出模型"：
     * 冷启第一次问必然空 ⇒ 落到 `source:'none'` ⇒ 会话拿不到模型，而没有任何人再回来重问
     * （不像 composer 有轮询）。⇒ 用等待版 `getHarnessModelCatalog`：这条路上多等一次冷启，
     * 好过给出一个编出来的"没有模型"。
     */
    getModelCatalog: async (id, options) => {
      const { getHarnessModelCatalog } = await import('./harness-model-catalog')
      return getHarnessModelCatalog(id, {
        leg: options.leg,
        harnessVersion: options.harnessVersion ?? null,
        ...(options.force ? { force: true } : {}),
      })
    },
    getPlatformCatalog: async (providerId, surface) => {
      const resolver = getPlatformModelCatalogResolver()
      if (!resolver) return null
      return resolver({ providerId, surface })
    },
  }
}
