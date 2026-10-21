import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';

/**
 * #6264「登录已失效」在界面上的读法 —— 纯函数,各个面(资源库、模型清单、会话页)共用这一份。
 *
 * 这一格由 agent-config worker 发布(会话被鉴权拒了就标上,重新登录成功或之后会话成功就撤掉),
 * 不是 CLI 自己的读数:凭据文件还在时 CLI 照答「已登录」。
 */
export function isAuthExpired(auth: AuthStatusModelState | null | undefined): boolean {
  const status = auth?.status;
  return status?.kind === 'unauthenticated' && status.reason === 'expired';
}

/**
 * 把「登录已失效」叠到模型目录的四态上。
 *
 * 目录探针自己判不出这一格(codex 没登录也列得出自家目录),照它画就是把一份用不了的清单说成能用。
 * 所以登录已失效时,自家那一组按「没登录」处理(空着、档位照留、默认落到咕咕的模型),多一格 `expired`
 * 让清单里那一条说「重新登录」。没装 / 不说 ACP / 读不出 这几态不动 —— 那是更靠前的事实。
 */
export function withAuthExpiry(state: HarnessCatalogState, expired: boolean): HarnessCatalogState {
  if (!expired) return state;
  switch (state.kind) {
    case 'auth-required':
      return { ...state, expired: true };
    case 'ready':
      return {
        kind: 'auth-required',
        authMethods: [],
        efforts: state.efforts,
        selectedEffort: state.selectedEffort,
        expired: true,
      };
    default:
      return state;
  }
}

/** 一整份 live state 里,哪几家此刻是「登录已失效」—— 给资源库图标网格一次读完,❌ 每格各订阅一份。 */
export function expiredProviderIds(list: Record<string, { auth?: AuthStatusModelState } | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const [providerId, entry] of Object.entries(list)) {
    if (isAuthExpired(entry?.auth)) ids.add(providerId);
  }
  return ids;
}

/**
 * 最近一轮是不是因为「登录不能用了」失败的 —— 读 session-runtime 分好类的那一格(`outcome.signInRequired`),
 * ❌ 不看回复原文。之后又有一轮(成功、取消、别的失败)就不再算:那时的状况由那一轮说。
 */
export function lastTurnSignInRequired(turns: readonly Pick<TranscriptTurn, 'outcome'>[]): boolean {
  const outcome = turns.at(-1)?.outcome;
  return outcome?.kind === 'error' && outcome.signInRequired === true;
}
