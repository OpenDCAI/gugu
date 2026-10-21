// 原因 → 一句话 + 一个按钮(#7103「谁拒绝谁说话」,product spec「被拒时谁说话」)。
// 新建框、起任务那一页、私聊横幅、通用模式那一行、弹窗、别的电脑上的失败都读这一张,❌ 在别处再按原因写一句、再配一套按钮。
// 纯模块(只依赖原因码与文案键;话由调用方的 translate 说),失败账本也读得了它。
//
// 分界按失败从哪一层来(主进程在那一层按错误类型定好):咕咕这一侧(model-access、平台凭证、咕咕本机自己判的)
// 一律带原因码到这里,不带原因的在那一层就成了 `service-unavailable`(「咕咕这边出错了」);咕咕以外(harness 起不来、
// provider 报错、自带模型)不带码,照 #4657 递拒绝方的原话 —— 去掉路径与令牌,只截一行。
import { guguReasonInText, guguReasonOf, type GuguCatalogReason } from '@gugu/session-core/session-record/contract';
import type { SessionMessageKey } from '@renderer/localization/messages';

/** 原因上的那一个按钮(规格原因表的按钮列);`null` = 只说一句(没有动作能改变它)。 */
export type GuguReasonAction = 'retry' | 'switch-model' | 'join-membership' | 'sign-in' | null;

export type GuguReasonCopy = {
  copy: SessionMessageKey;
  /** 能说出是哪个咕咕模型时用的那一句(`{model}` = 「咕咕 X」,照模型按钮上的叫法)。 */
  named?: SessionMessageKey;
  action: GuguReasonAction;
};

/** 认不出的(`unknown`)与内部故障(`service-unavailable`)同一句「咕咕这边出错了」。 */
const GUGU_REASONS: Record<GuguCatalogReason, GuguReasonCopy> = {
  'not-routable': { copy: 'guguCatalog.reason.not-routable', action: null },
  'no-identity-chat': { copy: 'guguCatalog.reason.no-identity-chat', action: null },
  'no-identity-terminal': { copy: 'guguCatalog.reason.no-identity-terminal', action: null },
  'runtime-not-connected': { copy: 'guguCatalog.reason.runtime-not-connected', action: null },
  'host-not-ready': { copy: 'guguCatalog.reason.host-not-ready', action: 'retry' },
  'none-for-agent': { copy: 'guguCatalog.reason.none-for-agent', action: null },
  'signed-out': { copy: 'guguCatalog.reason.signed-out', action: 'sign-in' },
  'service-unavailable': { copy: 'guguCatalog.reason.service-unavailable', action: 'retry' },
  'unreachable': { copy: 'guguCatalog.reason.unreachable', action: 'retry' },
  'membership-required': {
    copy: 'guguCatalog.reason.membership-required',
    named: 'guguCatalog.namedReason.membership-required',
    action: 'join-membership',
  },
  'model-unavailable': {
    copy: 'guguCatalog.reason.model-unavailable',
    named: 'guguCatalog.namedReason.model-unavailable',
    action: 'switch-model',
  },
  'unknown': { copy: 'guguCatalog.reason.unknown', action: 'retry' },
};

export function guguReasonCopy(kind: GuguCatalogReason): GuguReasonCopy {
  return GUGU_REASONS[kind];
}

type Translate = (key: SessionMessageKey, values?: Record<string, string>) => string;

/** 那一句话:说得出模型名就点名「咕咕 X」,说不出就用不带名字的那一句。 */
export function guguReasonText(kind: GuguCatalogReason, translate: Translate, modelName?: string | null): string {
  const entry = GUGU_REASONS[kind];
  return entry.named && modelName
    ? translate(entry.named, { model: translate('composer.platformModelShortName', { model: modelName }) })
    : translate(entry.copy);
}

/** 「回合失败」那一行带的原因(`outcome.guguReason`)→ 那一句。 */
export function refusalText(guguReason: string, translate: Translate, modelName?: string | null): string {
  return guguReasonText(guguReasonOf(guguReason), translate, modelName);
}

/** 各个界面手上真接得上的动作;没给的就不摆那颗按钮(控件要么真生效,要么不渲染)。 */
export type GuguReasonHandlers = {
  /** 人点的再试一次(调用方先清这条会话的取票退避,真去问一次)。 */
  retry?: () => void;
  switchModel?: () => void;
  joinMembership?: () => void;
};

export type GuguReasonButton = { kind: 'retry' | 'switch-model' | 'join-membership' | 'joined' | 'signed-in'; label: string; run: () => void };

/**
 * 原因 → 按钮。规格每个原因一个按钮;要会员的另带一颗「我开好了」(开完回来再起一次,真去问 ——
 * ❌ 让人关掉标签页重开)。登录失效:这几处手上没有咕咕的登录入口(登出时整个应用回登录页),
 * 给「我已登录」—— 在别处登好了回来,清掉退避再起一次。
 */
export function reasonActions(kind: GuguCatalogReason, handlers: GuguReasonHandlers, translate: Translate): GuguReasonButton[] {
  const { retry, switchModel, joinMembership } = handlers;
  switch (GUGU_REASONS[kind].action) {
    case 'join-membership':
      return [
        ...(joinMembership ? [{ kind: 'join-membership' as const, label: translate('chat.membershipJoin'), run: joinMembership }] : []),
        ...(retry ? [{ kind: 'joined' as const, label: translate('chat.membershipJoined'), run: retry }] : []),
      ];
    case 'switch-model':
      return switchModel ? [{ kind: 'switch-model', label: translate('chat.membershipSwitchModel'), run: switchModel }] : [];
    case 'sign-in':
      return retry ? [{ kind: 'signed-in', label: translate('chat.signInDone'), run: retry }] : [];
    case 'retry':
      return retry ? [{ kind: 'retry', label: translate('taskError.sessionStartRetry'), run: retry }] : [];
    default:
      return [];
  }
}

const MAX_FAILURE_LINE_LENGTH = 280;

/** 拒绝方原话的第一行:保留它说的事,去掉路径、profile、令牌与栈。 */
export function safeFailureLine(message: string): string {
  const firstLine = message
    .split(/\r?\n/, 1)[0]!
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s,)]+/g, '[path]')
    .replace(/(?:eyJ[A-Za-z0-9._-]+|(?<![A-Za-z0-9])(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+)/g, '[redacted token]')
    .trim();
  return firstLine.slice(0, MAX_FAILURE_LINE_LENGTH);
}

/** 这次失败带没带咕咕这一侧的原因码;null = 咕咕以外的失败,说拒绝方的原话。 */
export function failureReason(message: string): GuguCatalogReason | null {
  return guguReasonInText(message);
}

/**
 * 一次失败给人看的那一句 —— 起任务那一页、通用形态起会话那一行、私聊横幅、弹窗都经这里,说话规则只有这一份:
 * 带原因码(咕咕这一侧,主进程在那一层按错误类型打好)按原因表说;不带码的是拒绝方的原话(harness / provider),
 * 一行、去敏;原话是空的就是没人说清 ⇒「咕咕这边出错了」。
 */
export function failureText(message: string, translate: Translate, modelName?: string | null): string {
  const reason = failureReason(message);
  if (reason) return guguReasonText(reason, translate, modelName);
  return safeFailureLine(message) || guguReasonText('service-unavailable', translate);
}

/**
 * 按构造就是咕咕自己这一侧的失败(恢复协调器、本机运行时、宿主 IPC、这个 store 自己):带码就按码,
 * 不带码就是「咕咕这边出错了」,原文只进日志 —— ❌ 当成别人的原话递出去。
 */
export function guguFailureText(message: string, translate: Translate): string {
  return guguReasonText(failureReason(message) ?? 'service-unavailable', translate);
}
