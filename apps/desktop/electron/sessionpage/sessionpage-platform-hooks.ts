// @@@task-shell-port (#5012/#5057) — 「咕咕自营模型」这一套的宿主侧钩子,桌面主进程与网页版无头宿主共用。
//
// 从前这五个钩子的**实现**逐字写在 electron/main.ts 里(ACP 注入器 / release / checkpoint / PTY 平台解析),
// 于是网页版宿主一个都没有:composer 里「咕咕提供的模型」那一组的数据源没人应答,而它的失败是**静默**的
// (renderer 那侧 catch 掉、分组直接缺席,不弹错)⇒ 现象就是「网页版没有自营模型」,查不出原因。
//
// 这里只做一件事:把那几段与形态无关的实现抬出来,两种宿主各接一份。它们本来就只依赖两样东西 ——
// 登录态(RuntimeAuthProvider)、身份供给(SessionpageProvisionDeps),两样在两种宿主里都有。❌ 不在网页版另写一份:两份就会漂,而这正是 #5012 要消灭的那个形状。
//
// ⚠️ 本模块 ❌ 不碰 BrowserWindow / ipcMain / app,只被宿主接线调用。
import type { RuntimeAuthProvider } from '@gugu/core'
import { hasCredentialSink, requireInjectionContract, shouldReuseHeldPlatformToken } from '../engine-injection-contract'
import { findInjectionContract } from '../engine-injection-contract'
import {
  claudeAcpPlatformSessionMeta,
  codexPlatformAuthRequest,
  codexPlatformProviderBlock,
  CODEX_PLATFORM_PROVIDER_ID,
} from '@gugu/session-plugins/agents'
import { noteHostInjectedModel } from '../capability-report-store'
import { createLogger } from '../lib/logger'
import { platformEnvelopeKind } from '../platform-envelope'
import { guguCatalogReasonCode } from '@gugu/session-core/session-record/contract'
import type { EmdashPlatformInjection } from '../session/main/core/acp/emdash-platform-injector'
import { emdashPlatformReleaseIntent } from '../session/main/core/acp/emdash-platform-injector'

/**
 * ACP 注入器真正读到的那几格 —— 只声明**用到的**,❌ 不复用任何一侧的完整 start-info 类型。
 *
 * 理由是两侧的那个类型并不同形:引擎侧 `EmdashSessionStartInfo` 的 `lifecycle` 是必需的,而咕咕壳
 * (main.ts)在桥的边界上按结构手抄了一份镜像,那份没有 `lifecycle`。取任意一侧当入参,另一侧的
 * 调用点就会 TS2741 —— 而且报错落在装钩子那一行,不落在这里。这个模块是两个宿主共用的,
 * 它该要的是「这几格」,不是某一侧的全表。
 */
export interface SessionpagePlatformAcpInfo {
  sessionId: string
  sourceSessionId?: string
  projectId: string
  providerId: string
  cwd: string
  platformModel?: { modelId: string } | null
  agentDisplayName?: string
}
import type {
  PlatformModelCatalogQuery,
  PlatformModelCatalogSnapshot,
} from '../session/main/core/agents/platform-model-catalog-hook'
import type { EmdashPtySessionpageStartInfo } from '../session/main/core/sessions/impl/emdash-pty-sessionpage-hook'
import { awaitSessionpageCloudIdentity, provisionSessionpageAgentForSession, type SessionpageProvisionDeps } from './emdash-agent-provisioning'
import {
  checkpointPlatformModelForSession,
  expiredPlatformModelSessions,
  codexPlatformInjection,
  heldPlatformModelForSession,
  platformModelForSession,
  platformModelIsExpired,
  platformCredentialGenerationForSession,
  platformRelaySessionsRestored,
  releasePlatformModelForSession,
  releasePlatformModelsForSurface,
  type SessionpagePlatformModel,
} from './sessionpage-platform-model'
import { sessionpagePlatformCatalog } from './sessionpage-platform-catalog'
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins'
import type { PlatformCredentialRuntimeObservation } from './sessionpage-platform-recovery'
import { sessionPlatformModel } from '../session/main/core/sessions/platform-model-selection'

/**
 * 后台小模型那两档是**子进程独有**的钉扎:只有 claude 自己会用,适配器拿了没有读者,所以不进 adapterEnv。
 *
 * ⚠️ `ANTHROPIC_MODEL` 不在这张表里,而且不能加回去 —— 适配器**也**要读它。
 * `@agentclientprotocol/claude-agent-acp` 自己决定「这条会话当下是哪个模型」,顺序是
 * ①`process.env.ANTHROPIC_MODEL` ②`settings.model` ③resume 回来的实时模型 ④`models[0]`。
 * 它那份 settings 由 `new SettingsManager(params.cwd, …)` 从 user/project/local 三个标准来源读,
 * **看不到**我们用 `--settings` 交给 claude 的那份文档 ⇒ ② 恒空;①再被剔掉就只剩 ④,
 * 而 `applyAvailableModelsAllowlist()` 永远把 `default` 行放在第 0 位 ⇒ 当前模型被设成 Opus 档。
 *
 * 那个症状不长得像真因:**正文请求自始至终跑在用户选的模型上**(那条由 settings 文档里的
 * `ANTHROPIC_MODEL` 管),错的只是面板显示,外加每轮多一次走 opus 的小请求。#5882 在 Windows 实测:
 * 选 Sonnet 5,会话一建好(T+10s)面板就翻成 Opus 5,适配器打
 * `[session/models] … phase=set-model model=claude-opus-5 outcome=success`。
 *
 * ⇒ 模型 id 不是凭据,适配器与子进程读同一个值不构成第二个写入者(#5255 管的是凭据/网关值)。
 * 发现与自定义选项状态照旧留在 adapterEnv:Claude ACP 构造 picker 时要用。
 */
const CLAUDE_CHILD_ONLY_MODEL_ENV = new Set([
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
])

export function claudeAcpAdapterEnv(spawnEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spawnEnv).filter(([key]) => !CLAUDE_CHILD_ONLY_MODEL_ENV.has(key)),
  )
}

function requirePlatformAccessSessionId(platform: SessionpagePlatformModel): string {
  if (!platform.accessSessionId) {
    throw new Error('platform model launch is missing its access session id')
  }
  return platform.accessSessionId
}

/** 宿主自己的注入不变量坏了:界面只说「咕咕这边出错了」(#7103),写给开发者的那句只进日志。 */
function platformInjectionFault(detail: string, providerId: string): Error {
  createLogger('sessionpage/platform').error({ providerId }, detail)
  return new Error(guguCatalogReasonCode('service-unavailable'))
}

export interface SessionpagePlatformHooksDeps {
  /**
   * 这台宿主当下的登录态取数口。
   *
   * ⚠️ **是「取数口」不是「一个 provider」,而且这个区别是产品级的**:桌面壳的 `authProvider` 要等渲染层
   * 就绪(`startDeviceRuntimeWhenRendererReady`)才装上,而这组钩子在 `app.whenReady()` 里比它早得多就
   * 构造完了。收一个 provider 值 ⇒ 桌面壳只能在构造那一刻交出 `null`,钩子把它**永久**捕获,此后无论
   * 用户登没登录,平台令牌一律签不出来 —— #5092 实测:composer 下拉照常列出咕咕模型(那条 IPC 在
   * handler 体内现读),一按开始就 `platform model token requires authenticated Supabase runtime auth`。
   *
   * 返回 `null` = 运行时确实还没连上,由下游按「响亮失败」处理(那句话术是给用户看的中文)。
   */
  authProvider: () => RuntimeAuthProvider | null
  /** ACP 腿的身份供给(#5012):选了平台模型就得先有身份才能签令牌,幂等。 */
  provisionDeps: SessionpageProvisionDeps
  /**
   * PTY 腿的身份供给。桌面壳这一腿多挂了 `onTurnLifecycle`(sidecar 会话的回合边界),
   * 与 ACP 那份**不是同一个对象** —— 合成一份会悄悄改掉桌面的行为。惰性求值:它在
   * main.ts 里定义得比本对象晚,而这一格只在钩子真被调用时才读。缺省 = ACP 那份。
   */
  ptyProvisionDeps?: () => SessionpageProvisionDeps
  /**
   * 这条会话的推理进程还活着吗(codex 的 app-server 这类 sidecar)。令牌绑在哪个东西的存活上是
   * 引擎的进程拓扑决定的,所以这一格由宿主回答:桌面壳问它的 provisioning,
   * 无头宿主没有 sidecar ⇒ 缺省恒 false(与「表上没有这个引擎 ⇒ 不复用」同侧)。
   */
  inferenceProcessLive?: (sessionId: string) => boolean
  /** Mark a session expired; the host recovery coordinator reopens it on actual use. */
  onPlatformCredentialExpired?: (target: {
    sessionId: string
    projectId: string
    providerId: string
    surface: SessionpageSessionSurface
    expiresAt: string
    credentialGeneration?: string
  }) => void | Promise<void>
  onPlatformCredentialObservation?: (
    sessionId: string,
    observation: PlatformCredentialRuntimeObservation,
  ) => void
  onPlatformSessionEnded?: (sessionId: string) => void
  /** Re-arm provider turn waiters before expiry reconciliation after host wake. */
  onHostResume?: () => void
  env?: NodeJS.ProcessEnv
}

export interface SessionpagePlatformHooks {
  /** composer 下拉里「咕咕提供的模型」那一组的数据源。 */
  catalog(input: {
    providerId: string
    surface: SessionpageSessionSurface
    sessionId?: string | null
  }): ReturnType<typeof sessionpagePlatformCatalog>
  /**
   * `session_list_models` 那条工具面的「咕咕提供的模型」—— 与上面 `catalog` **同一次计算**,
   * 只是不带 conversationId(问的是「有哪些可选」,不是「这条会话上次预选了什么」)。
   * ⚠️ 装钩子的宿主必须两口都用这一份:agent 查到的与用户在下拉里看到的分岔一次,就再也对不上。
   */
  listModels(query: PlatformModelCatalogQuery): Promise<PlatformModelCatalogSnapshot>
  /**
   * ACP 腿:这条会话该用的平台启动值。**握着活令牌就沿用那一份** —— 见实现处的抬头。
   *
   * 能力注入器(它对自带进程配置/配置文件的引擎自己解析平台额度)必须走这一口,
   * ❌ 别再直接调 `platformModelForSession`:那样就绕开了「没有建立就不该有新凭据」。
   */
  acpPlatformModel(info: SessionpagePlatformAcpInfo): Promise<SessionpagePlatformModel>
  /** ACP 腿:这条会话的平台注入信封,或 null(不走平台额度)。可能抛 —— 签不出来就不该开。 */
  acpInjector(info: SessionpagePlatformAcpInfo): Promise<EmdashPlatformInjection | null>
  /** PTY 腿的**平台那一半**:复用判定 + 解析。宿主自己决定怎么与它的 provider hook 叠。 */
  ptyPlatform(info: EmdashPtySessionpageStartInfo): Promise<{ platform: SessionpagePlatformModel; reusedHeld: boolean }>
  release(sessionId: string | null, expectedAccessSessionId?: string, intent?: 'end' | 'restart'): Promise<void>
  checkpoint(sessionId: string): Promise<void>
  targetForSession(sessionId: string): {
    sessionId: string
    projectId: string
    providerId: string
    surface: SessionpageSessionSurface
    expiresAt?: string
    credentialGeneration?: string
  } | null
  /** Reconcile wall-clock expiry after the host wakes from sleep/freeze. */
  onHostResume(): Promise<void>
}

export function createSessionpagePlatformHooks(deps: SessionpagePlatformHooksDeps): SessionpagePlatformHooks {
  const env = deps.env ?? process.env
  const { provisionDeps } = deps
  const sessionTargets = new Map<string, {
    sessionId: string
    projectId: string
    providerId: string
    surface: SessionpageSessionSurface
    credentialGeneration?: string
    expiresAt?: string
  }>()
  // 现读,❌ 解构:见 SessionpagePlatformHooksDeps.authProvider 的抬头(#5092)。
  const authProvider = () => deps.authProvider()

  /**
   * 这条 ACP 会话该用的平台启动值 —— **握着活令牌就沿用那一份,❌ 不重签**。
   *
   * ## 为什么它必须是一个方法,而不是各调用点自己拼
   *
   * 「重签会撤掉活适配器手里那张票」这条纪律以前只写在下面 `acpInjector` 里,而 ACP 这条腿上
   * **签凭据的地方有三处**:这个注入器,以及能力注入器的 fresh / 运行时分叉两处(它们对
   * 「模型由自家进程配置或配置文件投递」的引擎自己解析平台额度,再用 `platformConfigured`
   * 让这个注入器整个跳过 —— opencode 正是那一族)。于是纪律只在**没被跳过的那一处**生效。
   *
   * 实测(2026-09-13,mac1 端口 9432,opencode + 咕咕 glm-5,base 404bd5e2):在一条**活着的**
   * 会话上刷新窗口 ⇒ 只有一次 startSession,worker 那边按 `SessionManager.start` 的幂等
   * 直接返回、什么都没建立,而这一步照旧「先撤旧、再签新」:`a2a0340c` 于 10:00:48.353 被撤,
   * `fbdc1e45` 于 .461 新签,**而真正在服务的适配器手里是被撤的那份** ⇒ 之后每一轮
   * `Internal error: Invalid token`(#5552)。#5550 是同一形状,只是它先多产生了一次建立。
   *
   * ⇒ 判据一句话:**没有建立,就不该有新凭据。** 复用因此是**强制**的,不是优化。
   * ❌ 不把这段判断抄进那两处 —— 抄三份等于承认第四处还会忘。
   */
  const resolveAcpPlatformModel = async (
    info: SessionpagePlatformAcpInfo,
  ): Promise<SessionpagePlatformModel> => {
    // ⚠️ 选了 harness 自家模型(**显式** null)就不许沿用 —— 那是「这条会话不上平台」这个决定,
    // 拿一份平台令牌去兑现它就是「界面写着自家模型、请求打着咕咕的票」。
    // (`undefined` = 存量会话,回退按 agent 级 model_access 解析,沿用照旧成立。)
    // 正常路径下走不到这里:换计费路是经重载发生的,而重载的 stop 已经把凭据结清了。
    // 这一格是**说清意图**,不是补漏 —— 少了它,下一个人从别处调进来就会踩。
    if (info.platformModel === null) {
      return await platformModelForSession({
        sessionId: info.sessionId,
        identitySessionId: info.sourceSessionId,
        providerId: info.providerId,
        authProvider: authProvider(),
        env,
        surface: 'cui',
        platformModel: null,
        onCredentialObservation: (observation) => deps.onPlatformCredentialObservation?.(info.sessionId, observation),
      })
    }
    // ⚠️ 这里用 `findInjectionContract`(不抛),**不是** `requireInjectionContract`:
    // 「这一格接没接线」是**信封**那一步的判据,由 `acpInjector` 照旧响亮拒;这一步只回答
    // 「能不能沿用手里那份」。在这里改成抛,会把「表上没有这一格」的引擎从**能签**变成**签不出**,
    // 而那是另一件事的裁决,不该由一次复用判断顺手做掉。契约缺席 ⇒ 不复用 ⇒ 与从前逐字相同。
    const contract = findInjectionContract(info.providerId, 'cui')
    const held = heldPlatformModelForSession(info.sessionId)
    const reuse = shouldReuseHeldPlatformToken(contract, {
      // ACP 适配器池没有可问的独立推理进程探针;这一族的令牌寿命绑适配器进程,
      // 「记录还在」就是「这条会话还没结束」(见 engine-injection-contract 的 tokenReuseProbe)。
      inferenceProcessLive: false,
      heldRecordExists: held !== null && !platformModelIsExpired(held),
    }) && held
    if (reuse) {
      createLogger('sessionpage/platform').info(
        {
          sessionId: info.sessionId,
          providerId: info.providerId,
          accessSessionId: reuse.accessSessionId,
        },
        '2503: reusing the platform access session this session already holds',
      )
      return reuse
    }
    return await platformModelForSession({
      sessionId: info.sessionId,
      identitySessionId: info.sourceSessionId,
      providerId: info.providerId,
      authProvider: authProvider(),
      env,
      surface: 'cui',
      platformModel: info.platformModel,
      onCredentialObservation: (observation) => deps.onPlatformCredentialObservation?.(info.sessionId, observation),
      // 新会话第一次启动时身份还没建 —— 选了平台模型就得先有身份才能签 token。幂等。
      awaitCloudIdentity: awaitSessionpageCloudIdentity,
      ensureAgentUserId: async () => (await provisionSessionpageAgentForSession(
        {
          // 运行时分叉没有身份,这里返回 null。平台额度不因此掉线 —— identitySessionId
          // 那一格已经只读解析出来源会话的 agent,额度记在它头上。
          sessionId: info.sessionId,
          sourceSessionId: info.sourceSessionId,
          providerId: info.providerId,
          surface: 'acp',
          cwd: info.cwd,
          projectId: info.projectId,
          displayName: info.agentDisplayName,
        },
        provisionDeps,
      ))?.guguAgentUserId ?? null,
    })
  }

  const acpPlatformModel = async (info: SessionpagePlatformAcpInfo): Promise<SessionpagePlatformModel> => {
    const platform = await resolveAcpPlatformModel(info)
    if (platform.accessSessionId) {
      sessionTargets.set(info.sessionId, {
        sessionId: info.sessionId,
        projectId: info.projectId,
        providerId: info.providerId,
        surface: 'acp',
        credentialGeneration: platform.accessSessionId,
        expiresAt: platform.expiresAt ?? undefined,
      })
    }
    return platform
  }

  return {
    acpPlatformModel,

    catalog: (input) => sessionpagePlatformCatalog({
      ...input,
      authProvider: authProvider(),
      sessionSelectionResolver: sessionPlatformModel,
      env,
    }),

    async listModels({ providerId, surface }) {
      const snapshot = await sessionpagePlatformCatalog({ providerId, surface, authProvider: authProvider(), env })
      return {
        models: snapshot.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          creditMultiplier: model.creditMultiplier,
          contextWindow: model.contextWindow,
          reasoningEfforts: model.reasoningEfforts,
          requiresMembership: model.requiresMembership,
          hidden: model.hidden,
        })),
        // ❌ 别把 catalogError 吞成空列表:「咕咕本来就没有模型」与「你这条腿用不了咕咕模型」
        // 在返回值里会逐字节相同,agent 就没法把原因转述给用户。
        catalogError: snapshot.catalogError,
      }
    },

    async acpInjector(info) {
      // composer 没做过决定(存量会话、自动化任务、派生子会话)→ 什么都不注入。
      //
      // ❌ 这里**不**回退 agent 级 model_access,pty 路那条回退不适用:那条回退的意义是「保住这些会话
      // 一直以来的行为」,而 Chat UI 会话一直以来的行为是**从来上不了平台**(创建期那道墙拦着)。在这里
      // 回退不是保住行为,是改变行为。选了 harness 自家模型(显式 null)同样不注入。
      if (!info.platformModel) return null
      const contract = requireInjectionContract(info.providerId, 'cui')
      const platform = await acpPlatformModel(info)
      // 解析下来不上平台(这个 agent 没有平台额度)→ 不注入,会话照常按它自己的配置跑。
      if (!Object.keys(platform.env).length) return null
      const platformAccessSessionId = requirePlatformAccessSessionId(platform)
      // 这条诊断从 main.ts 一起搬过来 —— 抽取不该顺手弄丢可观测性。用 logger 不用 console:
      // console 棘轮对新文件按「NEW console-member」判红(#5015 撞过同一形状)。
      createLogger('sessionpage/platform').info(
        { sessionId: info.sessionId, providerId: info.providerId, model: platform.model },
        '2503: platform model injected into Chat UI session',
      )
      // #4689 —— 把**这个决定**记进能力报告(❌ 不是去读活进程:报告不该依赖进程存活)。
      if (platform.model) {
        await noteHostInjectedModel(info.sessionId, platform.model, env)
      }
      // ⚠️ 分派本身在 `platformEnvelopeKind` 里,**不内联** —— 内联的那份没有判据够得到。
      const envelope = platformEnvelopeKind(contract, {
        spawnEnv: platform.spawnEnv,
        settingsDocumentPath: platform.settingsDocumentPath,
        platformProvider: platform.platformProvider,
        // 协议表原话随声明走:gemini 的中转是裸根,第三闸得对它而不是对 /v1 的 baseUrl(#4700)。
        platformSettingsEnv: platform.modelCapability?.platformSettingsEnv ?? null,
      })

      if (envelope === 'session-meta') {
        return {
          kind: 'session-meta',
          platformAccessSessionId,
          sessionMeta: claudeAcpPlatformSessionMeta({
            settingsDocumentPath: platform.settingsDocumentPath,
            // Platform model/gateway values live only in the 0600 settings document. The
            // ACP options.env slot is deliberately an empty child-process supplement; putting
            // the same values here would create a second override carrier and revive #5255's
            // precedence ambiguity.
            env: {},
          }),
          // The adapter still needs discovery/custom-option process state to construct its picker,
          // and `ANTHROPIC_MODEL` to name the session's current model (see the set above). Only the
          // child-only background tiers are stripped; relay credentials never enter this
          // conversation-owned adapter environment.
          adapterEnv: claudeAcpAdapterEnv(platform.spawnEnv),
          ...(platform.model ? { model: platform.model } : {}),
        }
      }

      if (!platform.model || !platform.platformProvider) {
        throw platformInjectionFault('Chat UI platform adapter is missing its model or relay configuration', info.providerId)
      }

      if (envelope === 'adapter-env') {
        // ❌ 只发 `platform.spawnEnv`,**不叠 `platform.env`**:这一族的凭据与模型钉定整份都在
        //    spawnEnv 里,而 `platform.env` 是中转那份**通用**环境。多叠一份没人读的键,只会让
        //    「凭据到底从哪条键进去的」在两个界面上答案不同。
        return {
          kind: 'adapter-env',
          platformAccessSessionId,
          spawnEnv: platform.spawnEnv,
          model: platform.model,
          ...(platform.adapterArgs.length > 0 ? { spawnArgs: platform.adapterArgs } : {}),
        }
      }

      if (envelope === 'adapter-spawn') {
        const provider = codexPlatformProviderBlock(platform.platformProvider)
        const authRequest = codexPlatformAuthRequest(platform.platformProvider)
        if (!provider || !authRequest) {
          throw platformInjectionFault('could not construct the codex Chat UI platform provider', info.providerId)
        }
        // 同一份声明的另一个信封,由 codexPlatformInjection 组装 —— ❌ 不在这里内联展开。
        return {
          kind: 'adapter-spawn',
          platformAccessSessionId,
          platform: codexPlatformInjection({
            model: platform.model,
            providerId: CODEX_PLATFORM_PROVIDER_ID,
            providerLabel: provider.name,
            baseUrl: provider.base_url,
            apiKey: platform.platformProvider.apiKey,
            authRequest,
            spawnEnv: platform.spawnEnv,
            contextWindow: platform.contextWindow,
            reasoningEfforts: platform.reasoningEfforts,
            switchableModels: platform.switchableModels,
            callableRoutes: platform.modelCapability?.platformCallableRoutes,
          }),
        }
      }

      throw platformInjectionFault('Chat UI platform injection dialect did not reach the adapter', info.providerId)
    },

    async ptyPlatform(info) {
      // 谁该复用、谁该重签,由引擎的注入契约说了算,不由这里认 provider 名字:令牌绑在哪个东西的
      // 存活上是引擎的进程拓扑决定的(codex 绑 app-server,claude TUI 绑可见进程本身)。
      //
      // 上一个宿主留在 tmux 里的票要先认回,才知道手里有没有:开机唤醒常常比认回早(见 restorePlatformRelaySessions)。
      await platformRelaySessionsRestored()
      const held = heldPlatformModelForSession(info.sessionId)
      const inferenceProcessLive = deps.inferenceProcessLive?.(info.sessionId) ?? false
      const reusedHeld = Boolean(
        shouldReuseHeldPlatformToken(findInjectionContract(info.providerId, 'tui'), {
          inferenceProcessLive,
          heldRecordExists: held !== null && !platformModelIsExpired(held),
        }) && held,
      )
      if (reusedHeld && held) return { platform: held, reusedHeld: true }
      // #6264 接回 tmux 里还在跑的 agent(不会起新的):它手里就是当初那份凭据,原样交回,❌ 另签一张
      // (重签会先撤掉、删掉它正在用的那份)。接回还是新起由起进程的那一处判定(`info.start`),这里不再问 tmux。
      if (held && info.start === 'reattach') return { platform: held, reusedHeld: true }
      const platform = await platformModelForSession({
        sessionId: info.sessionId,
        providerId: info.providerId,
        authProvider: authProvider(),
        env,
        surface: 'tui',
        // Runtime forks have no conversation row of their own; the shared platform boundary
        // reads the selected effort from the persisted source conversation.
        identitySessionId: info.sourceSessionId,
        // @@@2503 composer 是会话的唯一决策点:选平台模型才上 relay,选 harness 自家模型不注入任何东西。
        platformModel: info.platformModel,
        onCredentialObservation: (observation) => deps.onPlatformCredentialObservation?.(info.sessionId, observation),
        awaitCloudIdentity: awaitSessionpageCloudIdentity,
        ensureAgentUserId: async () => (await provisionSessionpageAgentForSession(
          {
            sessionId: info.sessionId,
            providerId: info.providerId,
            surface: 'tui',
            cwd: info.cwd,
            projectId: info.projectId,
            displayName: info.agentDisplayName,
          },
          deps.ptyProvisionDeps?.() ?? provisionDeps,
        ))?.guguAgentUserId ?? null,
      })
      // Register every PTY target after startup. onHostResume filters this map through
      // active expired platform generations, so non-platform sessions are inert while
      // Claude TUI credentials carried in spawnEnv cannot miss the reopen path.
      sessionTargets.set(info.sessionId, {
        sessionId: info.sessionId,
        projectId: info.projectId,
        providerId: info.providerId,
        surface: 'tui',
        credentialGeneration: platform.accessSessionId ?? undefined,
        expiresAt: platform.expiresAt ?? undefined,
      })
      return { platform, reusedHeld: false }
    },

    async release(sessionId, expectedAccessSessionId, intent = emdashPlatformReleaseIntent(sessionId, expectedAccessSessionId)) {
      // conversationId 为 null = 运行时整个没了,把 Chat UI 这一批全结清(终端会话那批的进程还活着,
      // 一起撤会把它们打成每轮 401)。
      if (sessionId === null) {
        for (const [id, target] of sessionTargets) {
          if (target.surface === 'acp') deps.onPlatformSessionEnded?.(id)
        }
        await releasePlatformModelsForSurface('cui')
        for (const [id, target] of sessionTargets) {
          if (target.surface === 'acp') sessionTargets.delete(id)
        }
        return
      }
      const generation = platformCredentialGenerationForSession(sessionId)
      if (expectedAccessSessionId !== undefined && generation && generation !== expectedAccessSessionId) return
      if (intent === 'end') deps.onPlatformSessionEnded?.(sessionId)
      await releasePlatformModelForSession(sessionId, expectedAccessSessionId)
      if (!platformCredentialGenerationForSession(sessionId)) sessionTargets.delete(sessionId)
    },

    checkpoint: (sessionId) => checkpointPlatformModelForSession(sessionId),

    targetForSession(sessionId) {
      const target = sessionTargets.get(sessionId)
      if (!target) return null
      const held = heldPlatformModelForSession(sessionId)
      if (target.credentialGeneration && !held) return null
      return {
        ...target,
        credentialGeneration: held?.accessSessionId ?? undefined,
        expiresAt: held?.expiresAt ?? undefined,
      }
    },

    async onHostResume() {
      deps.onHostResume?.()
      const expired = expiredPlatformModelSessions()
      createLogger('sessionpage/platform').info({ expired, targetCount: sessionTargets.size }, '平台凭据恢复对账开始')
      for (const sessionId of expired) {
        const target = sessionTargets.get(sessionId)
        const held = heldPlatformModelForSession(sessionId)
        if (!target || !held?.expiresAt) continue
        createLogger('sessionpage/platform').info({ sessionId, target }, '平台凭据恢复命中过期会话')
        await deps.onPlatformCredentialExpired?.({
          ...target,
          expiresAt: held.expiresAt,
          credentialGeneration: platformCredentialGenerationForSession(sessionId) ?? undefined,
        })
      }
    },
  }
}

/** PTY 腿:把解析出来的平台声明叠到引擎自己的启动参数上(无 provider hook 的宿主走这条)。 */
export function applyPlatformToPtyLaunch(
  info: EmdashPtySessionpageStartInfo,
  platform: SessionpagePlatformModel,
): { command: string; args: string[]; env: Record<string, string> } | null {
  // 没选平台模型 ⇒ 一个字节都不改,启动参数与从前逐字相同。
  if (!Object.keys(platform.env).length) return null
  const contract = findInjectionContract(info.providerId, 'tui')
  const clientArgs = contract && hasCredentialSink(contract, 'visibleClient', 'providerConfigArgs')
    ? platform.clientArgs
    : []
  return {
    command: info.baseCommand,
    args: [...info.baseArgs, ...clientArgs],
    env: { ...platform.env, ...platform.spawnEnv },
  }
}
