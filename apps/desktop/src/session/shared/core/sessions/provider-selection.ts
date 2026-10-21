import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { PREFERRED_SESSION_PROVIDERS } from './new-session-defaults';

export type SessionpageIntegration = {
  identity: 'addressable' | 'none';
  messageTransport: 'router' | 'local-session' | 'none';
  inbound?: 'deliverable' | 'none';
};

export function hasUsableSessionpageIntegration(
  integration: SessionpageIntegration | undefined
): boolean {
  return integration?.identity === 'addressable'
    && integration.messageTransport !== 'none'
    && integration.inbound !== 'none';
}

export type SessionpageLegName = 'acp' | 'tui';

/**
 * 这个 agent 在会话页上**实际会跑在哪条腿**上 —— `null` = 两条腿都不可用（不该出现在选择器里）。
 *
 * ⚠️ 会话形态是**按引擎**定的，不是一个全局开关说了算。Chat UI 那个开关的真实含义是
 * 「**两条腿都能跑**的引擎，优先用哪条」；只有一条腿的引擎跟着自己那条走。
 *
 * ⚠️ 2026-08-28 之前这里没有这个概念：清单直接按开关选出的那一个 surface 过滤，于是
 * **只有协议腿的引擎在开关关着时整个从选择器里消失**（owner 实测：kimi 看不到，且残留的选择
 * 还会渲染出一句红字 `Agent "kimi" has no usable session-page integration for this session mode`）。
 * 反向同理：只有终端腿的家（amp / commandcode / zero 那些）在开关开着时也会消失。
 * ⇒ 判「能不能选」用这个函数，判「跑哪条腿」也用它，两处答案从此不可能分叉。
 */
export function sessionpageLegFor(
  sessionpage: Partial<Record<SessionpageLegName, SessionpageIntegration>> | undefined,
  preferred: SessionpageLegName
): SessionpageLegName | null {
  const usable = (surface: SessionpageLegName) =>
    hasUsableSessionpageIntegration(sessionpage?.[surface]);
  if (usable(preferred)) return preferred;
  const other: SessionpageLegName = preferred === 'acp' ? 'tui' : 'acp';
  return usable(other) ? other : null;
}

type ResolveSessionProviderSelectionParams = {
  defaultProviderId: AgentProviderId | null;
  providerOverride: AgentProviderId | null;
  /**
   * 上一次真的启动过会话时用的那家 —— 一条**记忆**,不是这一次的选择。
   *
   * ⚠️ 它必须与 `providerOverride` 分开走:从前记忆是拿来**初始化** override 那格 state 的,
   * 于是「重置这一次的选择」(换项目时 `setProviderOverride(null)`)会连记忆一起抹掉,用户
   * 上次明明选过 claude,新建一个项目打开就成了「还没选」。分开之后重置只回到记忆,不回到空。
   */
  rememberedProviderId?: AgentProviderId | null;
  knownProviderIds: AgentProviderId[];
  /** Providers with a usable session-page integration for the selected session mode. */
  sessionpageProviderIds?: AgentProviderId[];
  installedProviderIds: AgentProviderId[];
  /**
   * #6264 没装、但**点了就能用**的那几家:别的机器上建会话时,那台机器上没装的当场装
   * (behavior gugu-server 第 6 条)。只认用户这一次亲手点的(`providerOverride`);
   * 记忆 / 默认 / 兜底照旧只落在装着的家上 —— ❌ 替人挑一家要先装一两分钟的。
   */
  installOnCreateProviderIds?: AgentProviderId[];
  availabilityKnown: boolean;
};

/**
 * 唯一还需要出声的原因:这个 agent 在这里**没有可用的会话腿**(sessionpage 全空,或 SSH 工作区下
 * 只剩终端腿)。它与「没装」不同 —— 那时选择器自己就是答案(见下方 `resolve` 的抬头),而这里
 * 选择器整个是空的,换一个也换不出来,所以必须有一句交代。
 */
export type ProviderSelectionErrorCode = 'no-sessionpage-session';

/**
 * 结构化错误:文案在 hook 层走本地化表渲染(product spec:19「实现术语
 * 不直接展示给用户」—— 从前这里拼英文串直出,owner 截图里那句
 * `has no usable session-page integration for this session mode` 就是它),纯函数只表态原因。
 */
export type ProviderSelectionError = {
  code: ProviderSelectionErrorCode;
  providerId: AgentProviderId | null;
};

export type SessionProviderSelection = {
  providerId: AgentProviderId | null;
  createDisabled: boolean;
  error: ProviderSelectionError | null;
  /**
   * 选中的这一个是**用户自己表过态的**(他这次点的 / 上次真的用过的 / 设置里写的),而不是我方
   * 按出厂偏好猜的。
   *
   * ⚠️ 记忆只该记用户的选择:出厂偏好猜出来的那个一旦被写进「上次用过的」,它在解析顺序里就
   * 排到了「设置里的默认」前面 —— 用户后来在设置里选的那家从此永远不生效,而他从没选过 codex。
   */
  chosenByUser: boolean;
};

/**
 * 出厂偏好:没有任何用户选择可沿用时优先 Codex,再 Claude(owner 2026-10-20)。
 * 两家都不在本机时由下面的「任意一个有效候选」顶上,❌ 不因为偏好的那两家
 * 没装就回到空态。⚠️ 次序在这里,❌ 不要改成读 agent 目录顺序:那份顺序为别的事排的,跟着它漂
 * 等于这条偏好随时会变。
 */


/**
 * 选中哪个 agent —— **选中的那个必须是本机真的装了、并且在这里开得了会话的**;真的一个候选
 * 都不成立时才是「还没选」,那是一个合法的空态,❌ 不是错误。
 *
 * 顺序:这一次的显式选择 → 上次真的启动过的那家 → 设置里的默认 → 可用的 Codex → 可用的
 * Claude → 任意一个可用候选 → 空。
 *
 * ⚠️ 2026-09-20 之前末两档是「本机**唯一**装了的那家 → 空」,即装了两家以上就留空,理由是
 * 「替他猜等于替他决定」。owner 2026-09-20(#5973)推翻了这一条,2026-09-21 第三次复述:
 *
 *   > 智能体不能说我有安装,而这里一个不选。我刚刚新建了个项目,然后输入框我发现就还得让我选智能体。
 *
 * ⇒ 有装得好、这里开得了会话的 agent 时,创建器**必须**选中一个;留空只留给真的一个可用的都
 *   没有那一种。「不替用户猜」保护的是选择权,而选择器一直在那里、改一下就是一次点击 —— 用
 *   它换来的是**每一次新建都要先点一遍**,代价远大于它救下的东西。
 *
 * ⚠️ 2026-09-17 之前这里有三个「错误」码:`not-installed` / `no-default-agent` / `unknown-agent`。
 * 三个都是**用户在界面上到不了的状态** —— 选择器里没装的那些行点下去走的是安装跳转、
 * 不会变成选中项(`composer-agent-selector.tsx`「带 action 的行」那段),所以选中一个没装的 agent
 * 这件事用户根本做不到。它们全部来自我方:出厂默认写死 `claude`(`settings-registry.ts`)、
 * 记住的 id 退役、设置为空。owner 2026-09-17 真机实遇 —— 全新 Windows 装完打开「新建任务」,
 * 输入框下面直接一行红字「Claude Code 在当前连接上不可用」,而他什么都没点过:
 *
 *   > 这不是用户去选了一个还没装的 agent … 如果用户刚下载下来,什么 agent 都没装过,
 *   > 那自然就是一个 agent 都没选。我们应该有一个「一个 agent 都没有选」的默认状态,
 *   > 而不是直接报错。
 *
 * ⇒ 候选指不着就往下走,末位是「空」。红字留给用户真的无能为力的那一种(见上面那个 code)。
 * 记忆(上次用过的、设置里的默认)在它被卸载或退役之后一律按上面的顺序重算,❌ 不停在选中位
 * 报错 —— 那是我方记忆过期,不是用户做错了什么。
 *
 * ⚠️ 唯一的例外是 `providerOverride`:那一格里放着的东西要么是用户刚点的,要么是某条已存记录
 * (自动化)带进来的。它在这里开不了会话时**保留并出声**,❌ 默默换一家 —— 换了之后用户一点
 * 保存,他存了很久的那条配置就被改写成了别人。
 */
export function resolveSessionProviderSelection({
  defaultProviderId,
  providerOverride,
  rememberedProviderId = null,
  knownProviderIds,
  sessionpageProviderIds = knownProviderIds,
  installedProviderIds,
  installOnCreateProviderIds = [],
  availabilityKnown,
}: ResolveSessionProviderSelectionParams): SessionProviderSelection {
  const installedSet = new Set(installedProviderIds);
  const isKnown = (id: AgentProviderId) => knownProviderIds.includes(id);
  const hasSessionpageLegHere = (id: AgentProviderId) => sessionpageProviderIds.includes(id);
  const isSelectable = (id: AgentProviderId) =>
    isKnown(id) && hasSessionpageLegHere(id) && installedSet.has(id);

  // 这一格里放着的那个 id 在这里开不了会话 —— 原样保留并出声,❌ 不默默换一家。
  // ⚠️ 它不只是「用户刚点的」:自动化的编辑面把这条自动化**存着的**那个 agent 从这里传进来
  //    (`useAutomationFormState.ts` 的 seedProvider)。默默换一家,用户点保存就把他存了很久的
  //    配置改写成了别人 —— 比空着一格更坏。
  // ⚠️ 这一条在探测回来之前也要判:它读的是 agent 的**声明**,与装没装无关。
  if (providerOverride && isKnown(providerOverride) && !hasSessionpageLegHere(providerOverride)) {
    return {
      providerId: providerOverride,
      createDisabled: true,
      error: { code: 'no-sessionpage-session', providerId: providerOverride },
      chosenByUser: true,
    };
  }

  const candidates = [providerOverride, rememberedProviderId, defaultProviderId].filter(
    (id): id is AgentProviderId => id !== null && id !== undefined
  );
  /** 记忆/设置里那个在这里开不了会话,且换一个也换不出来 —— 这时才出声。 */
  const leglessNotice = (): SessionProviderSelection => {
    const legless = candidates.find((id) => isKnown(id) && !hasSessionpageLegHere(id)) ?? null;
    return legless
      ? {
          providerId: legless,
          createDisabled: true,
          error: { code: 'no-sessionpage-session', providerId: legless },
          chosenByUser: true,
        }
      : { providerId: null, createDisabled: true, error: null, chosenByUser: false };
  };

  // 探测还没回来时别把已选的那家降下去 —— 否则每次打开新建任务都先闪一下空态再跳回来。
  // 还不认识的 id 此刻也留着:`agents` 目录同样是异步来的,按「不认识」把它筛掉就是那一闪。
  if (!availabilityKnown) {
    const candidate = candidates.find((id) => !isKnown(id) || hasSessionpageLegHere(id)) ?? null;
    return candidate
      ? { providerId: candidate, createDisabled: false, error: null, chosenByUser: true }
      : leglessNotice();
  }

  if (
    providerOverride &&
    isKnown(providerOverride) &&
    hasSessionpageLegHere(providerOverride) &&
    installOnCreateProviderIds.includes(providerOverride)
  ) {
    return { providerId: providerOverride, createDisabled: false, error: null, chosenByUser: true };
  }

  const carriedOver = candidates.find(isSelectable);
  if (carriedOver) {
    return { providerId: carriedOver, createDisabled: false, error: null, chosenByUser: true };
  }

  // 没有可沿用的:选一个真的能用的。先按上面那条偏好(Codex → Claude)挑,两家都不在就取本机
  // 可用清单的第一条(顺序 = agent 目录顺序,同一台机器上稳定,❌ 不随渲染次序漂)。
  const selectableHere = [...new Set(sessionpageProviderIds.filter(isSelectable))];
  const fallback =
    PREFERRED_SESSION_PROVIDERS.find((id) => selectableHere.includes(id)) ??
    selectableHere[0] ??
    null;
  // chosenByUser=false:这是我方猜的,❌ 不许被记成「用户上次用过的」。
  if (fallback) {
    return { providerId: fallback, createDisabled: false, error: null, chosenByUser: false };
  }

  // 走到这里 = 这台设备上一个可用候选都没有。分两种:腿不通(SSH 远程项目 + 终端会话,
  // 选择器本身是空的)要出声;单纯没装是 #5740 那个合法空态,❌ 不报错。
  return leglessNotice();
}

/**
 * The engine the new-session memory names (app setting `newSessionMemory`): the one picked by hand, else the one last
 * started — unless that one was the factory guess, which must never outrank settings' default agent. The box and main
 * both read it, and feed it to `resolveSessionProviderSelection` as `rememberedProviderId`.
 */
export function rememberedProviderOf(
  memory: { lastPicked: AgentProviderId | null; lastStarted: { provider: AgentProviderId; providerChosenByUser: boolean } | null } | null | undefined
): AgentProviderId | null {
  if (memory?.lastPicked) return memory.lastPicked;
  return memory?.lastStarted?.providerChosenByUser ? memory.lastStarted.provider : null;
}
