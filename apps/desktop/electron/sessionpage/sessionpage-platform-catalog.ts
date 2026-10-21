// @@@2503 composer 平台模型 — 会话页 composer 下拉里「咕咕提供的模型」那一组的数据源。
//
// composer 是会话的唯一决策点(product spec):用户在这里并列看到 harness 自家模型和
// 平台模型,选哪个决定这次会话上不上平台 relay。所以这个目录必须按**将要启动的 provider**过滤 ——
// 一个不能被指向 relay 的引擎(没有协议映射)一个平台模型都不该列出来,列了就是让人选一个选了也没用的东西。
//
// 倍率(New API ratio)纯展示:拿不到就是 null,UI 少显示一个数字,分组照常在。

import {
  cachedAgentModelSelection,
  type RuntimeAuthProvider,
} from '@gugu/core'
// channel 名与条目形状是两侧共用的契约,定义在渲染层的 shared 目录 —— 这里只 import,
// ❌ 别在主进程再写一份字面量/接口:两份就会漂。相对路径(而非 @shared 别名)是因为这个文件
// 进的是咕咕主进程那次 rollup,与会话页 main 的 esbuild 包不共享别名表。
import {
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  offeredInModelPicker,
  type PlatformModelOption,
} from '../../src/session/shared/core/agents/platform-model'
import { guguCatalogReasonCode } from '@gugu/session-core/session-record/contract'
import { platformProtocolForEngine } from '../engine-injection-contract'
import { listPlatformModels, modelAccessFailureReason } from '../model-access'
import { createLogger } from '../lib/logger'
import { canProvisionSessionpageAgent } from './emdash-agent-provisioning'
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins'
import { localAgentForSession } from './sessionpage-session-agent'

export { SESSIONPAGE_PLATFORM_CATALOG_CHANNEL }

const log = createLogger('sessionpage/platform-catalog')

export interface SessionpagePlatformCatalog {
  models: PlatformModelOption[]
  /**
   * 这个会话对应 agent 的平台预选(agent 级 model_access 退位后的唯一用途:下拉的默认值)。
   *
   * 只有传了 conversationId 且那个会话已经有身份时才可能非 null —— 新建会话时身份还不存在,
   * 没有「上一次选了什么」可讲,预选就是 harness(纯 BYOK),这正是产品默认。
   */
  agentDefault: { modelId: string } | null
  /** Explicit composer decision for this conversation; absent for legacy/imported sessions. */
  sessionSelection?: { modelId: string } | null | undefined
  /**
   * 目录取不到的原因码(`guguCatalogReasonCode`;没登录 / 控制面不可达 …),❌ 失败原文。
   * composer 与 agent 工具面(`session_list_models`)拿到的都是这个码,各自按界面语言说人话;
   * 原文(可能是 `net::ERR_PROXY_CONNECTION_FAILED` 这类网络层串,#6478 mac1 实测)只进日志。
   *
   * ❌ 不 throw:harness 自家模型那一组必须照常可选,平台分组读不出来只是少一组。但也 ❌ 不静默 ——
   * 空列表和「说得出口的原因」是两回事。
   */
  catalogError: string | null
}

/** 每次都造一份新的:返回值会被结构化克隆送出去,但同进程的调用方不该共享同一个数组。 */
export type SessionSelectionResolver = (
  sessionId: string,
) => Promise<{ modelId: string } | null | undefined>

function empty(
  catalogError: string | null = null,
  sessionSelection?: { modelId: string } | null | undefined,
  includeSessionSelection = false,
): SessionpagePlatformCatalog {
  return {
    models: [],
    agentDefault: null,
    ...(includeSessionSelection ? { sessionSelection } : {}),
    catalogError,
  }
}

/**
 * 下面两条是**这道门自己的定性**,不是外部失败的转述。
 *
 * ⚠️ 为什么必须有:原因码是 composer 唯一能说话的口子 ——
 * `initial-session-section.tsx` 的 `platformNotice` 在会话页里就由它翻译而来
 * (`guguCatalogNotice(catalogError)`)。门关着却返回 `null`,界面上的样子与
 * 「咕咕本来就一个模型都没有」**逐像素相同** —— 用户看到分组消失、一句话没有,
 * 只能理解成界面坏了。owner 2026-08-21 对同一形状拍过板:分组不在时要补一句定性。
 *
 * ⚠️ 措辞跟既有产品口径走(「咕咕模型尚未对这个 Agent 开通」,见 `guguCatalog.reason.not-routable`),
 * ❌ 不另起一种腔调。区别只在这里多说**哪条腿** —— 那正是既有那句说不出、而用户
 * 一定要知道的一格:同一个 Agent,Chat UI 开着一个模型都没有、关掉就有。
 *
 * ⚠️ 只说**已经成立的事实**,❌ 不给「关掉 Chat UI 就能用」这类出路:那要求另一条腿的模型投递
 * 真的通,而它逐家不同(qoder 的终端腿今天只发 `QODER_MODEL`、不写那份定义模型的 settings
 * 文档 ⇒ 起会话时 `Invalid model`)。给一条走不通的出路比不给更坏。
 *
 * 这些格子里装的是**原因码**(`guguCatalogReasonCode`),由各端按界面语言翻译;失败原文只进日志。
 */
const ENGINE_NOT_ROUTABLE = guguCatalogReasonCode('not-routable')

function noSessionpageIdentity(surface: SessionpageSessionSurface): string {
  return guguCatalogReasonCode(surface === 'acp' ? 'no-identity-chat' : 'no-identity-terminal')
}

/**
 * 读目录失败 → 一个用户能照着做点什么的码。原文(服务端的英文诊断、网络栈报错)❌ 进码,只进日志:
 * 测试库没配网关时服务端回 503 `model access server is not configured`,它曾原样铺进新建任务的工具栏。
 */
export function platformCatalogFailureReason(error: unknown): string {
  return guguCatalogReasonCode(modelAccessFailureReason(error))
}

export async function sessionpagePlatformCatalog(input: {
  authProvider: RuntimeAuthProvider | null
  providerId: string
  surface: SessionpageSessionSurface
  /** 已存在的会话(改选/复查时)。新建会话时没有,预选自然为空。 */
  sessionId?: string | null
  /** Host-owned persistence read; omitted by pure catalog callers and legacy test harnesses. */
  sessionSelectionResolver?: SessionSelectionResolver
  env?: NodeJS.ProcessEnv
}): Promise<SessionpagePlatformCatalog> {
  const providerId = input.providerId.trim()
  const sessionId = input.sessionId?.trim()
  const includeSessionSelection = Boolean(sessionId && input.sessionSelectionResolver)
  const sessionSelection = includeSessionSelection
    ? await input.sessionSelectionResolver!(sessionId!)
    : undefined
  // 协议由插件声明(platformProtocolForEngine)。没有协议 = 这个引擎无法被指向平台 relay,
  // 对它而言平台模型不存在 —— 空列表,不是错误。
  const protocol = providerId ? platformProtocolForEngine(providerId) : null
  // 平台 token 签给一个咕咕 agent 身份,所以拿不到身份的 provider 一个平台模型都不该列 —— 列了会让
  // 用户选中一个签不出 token 的模型,而那在启动路径上只能响亮失败,不如一开始就不给选。
  //
  // @@@2503 这道门本身是对的,错的是它曾经问的名单:opencode 在 platform_models.engine_ids 里、协议有
  // (OPENAI_API_KEY)、模型注入方言也有(opencode-config-content),却因为身份名单当时只按「投递走哪条腿」
  // 收人而被整组挡掉 —— 症状是「列得出却签不出」。现在直接读 registry 的 exact provider/surface
  // identity 轴：OpenCode 只保留 acp，已适配的 tui harness 也都明确可寻址（2026-09-21
  // #6097 删掉八家后是 24 家，原 31 家）；没有 sessionpage cell 的家不会进入会话页平台模型目录。
  //
  // ⚠️ 两条**分开判**,❌ 不再合成一句 `!protocol || !canProvision`:它们是两个不同的原因
  // (「这家根本指不向中转」 vs 「这条腿还没接通咕咕身份」),而合并之后只能给出一个共同的
  // 空结果 —— 那正是这道门过去静默的方式。
  if (!protocol) return empty(ENGINE_NOT_ROUTABLE, sessionSelection, includeSessionSelection)
  if (!canProvisionSessionpageAgent(providerId, input.surface)) {
    return empty(noSessionpageIdentity(input.surface), sessionSelection, includeSessionSelection)
  }
  if (!input.authProvider) {
    return empty(guguCatalogReasonCode('runtime-not-connected'), sessionSelection, includeSessionSelection)
  }

  let models: PlatformModelOption[] = []
  let catalogError: string | null = null
  try {
    models = (await listPlatformModels(input.authProvider))
      // ❌ 这里曾经还有一道 `model.engineIds.includes(providerId)`。它是一张**人工准入名单**,
      // 而准入与否已经被上面的 `protocol`(引擎说哪条协议,编译期完备的代码事实)和这里的
      // `protocols`(模型支持哪条协议,运营数据)完整决定 —— 名单只能让结果比事实更严,
      // 而更严的那部分没有依据。#3813 就是这么坏的:五家的方言与协议全配齐,没人记得改名单。
      .filter((model) => model.enabled && model.protocols.includes(protocol))
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        protocol,
        creditMultiplier: model.creditMultipliers[protocol] ?? null,
        // 目录条目本来就带着它(端点 select 了 `context_window`、`model-access.ts` 已解析),
        // 只是一直没往下递 ⇒ 咕咕的模型成了这张下拉里唯一没有能力说明的一档。
        contextWindow: model.contextWindow,
        // 推理档同理:目录逐模型下发(#6447),composer 拿它与 harness 的清单取交集。
        reasoningEfforts: model.reasoningEfforts,
        requiresMembership: model.requiresMembership,
        hidden: model.hidden,
      }))
  } catch (error) {
    catalogError = platformCatalogFailureReason(error)
    log.warn({ providerId, surface: input.surface, reason: catalogError, err: error }, 'platform model catalog unavailable')
  }

  return {
    models,
    agentDefault: await agentDefault(input, models),
    ...(includeSessionSelection ? { sessionSelection } : {}),
    catalogError,
  }
}

async function agentDefault(
  input: { sessionId?: string | null; env?: NodeJS.ProcessEnv },
  models: PlatformModelOption[],
): Promise<{ modelId: string } | null> {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return null
  const agent = await localAgentForSession(sessionId, input.env ?? process.env)
  if (!agent) return null
  const selection = cachedAgentModelSelection(agent)
  if (selection.source !== 'platform') return null
  // 预选必须是下拉里真有的那一项:agent 上可能留着一个对这个 provider 已经不开放的模型,
  // 拿它去预选会让下拉显示一个选不中的值。会员到期后留着的会员模型、他在设置里关掉的模型同理(#7056)。
  return models.some((model) => model.id === selection.modelId && offeredInModelPicker(model))
    ? { modelId: selection.modelId }
    : null
}
