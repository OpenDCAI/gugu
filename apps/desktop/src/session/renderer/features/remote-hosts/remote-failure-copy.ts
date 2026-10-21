// #6264 在别的机器上建会话 / 起会话失败时给人看的那一句,以及会话打开后转录末尾那一行。
//
// 机器报的是原因码(`remoteFailureKind` 归类);这里按界面语言说「哪台机器、出了什么事、接下来做什么」。
// 原文 ❌ 进这里的任何一句 —— 它在那台机器的日志里、这台桌面的日志里,转录那一行的悬停里只放原因码。
// 纯函数(翻译函数注入),每条判据都有单测。
import {
  guguReasonInText,
  remoteFailureKind,
  type RemoteFailureKind,
  type SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract';
import { guguReasonCopy, guguReasonText } from '@renderer/features/sessions/gugu-reason';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { Translate } from './connection-status';
import { lastTurnSignInRequired } from '@renderer/lib/stores/harness-auth-expiry';

const CREATE_COPY: Record<RemoteFailureKind, Parameters<Translate>[0]> = {
  'model-service-unreachable': 'remoteFailure.modelServiceUnreachable',
  'agent-signed-out': 'remoteFailure.agentSignedOut',
  'agent-install-failed': 'remoteFailure.agentInstallFailed',
  'agent-runtime-missing': 'remoteFailure.agentRuntimeMissing',
  'agent-not-found': 'remoteFailure.agentNotFound',
  'model-unavailable': 'remoteFailure.modelUnavailable',
  'option-rejected': 'remoteFailure.optionRejected',
  'folder-unavailable': 'remoteFailure.folderUnavailable',
  'attachment-missing': 'remoteFailure.attachmentMissing',
  'machine-unreachable': 'remoteFailure.machineUnreachable',
  'machine-sign-in-required': 'remoteFailure.machineSignInRequired',
  'machine-outdated': 'remoteFailure.machineOutdated',
  'start-failed': 'remoteFailure.startFailed',
};

/** 出错对象上的业务码(SessionpageRpcError 在 gugu 侧 bundle,按形状读);没有 = 传输层失败。 */
export function remoteErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : null;
}

/**
 * 输入框下那一句:建会话失败(会话行还没写下,人还在新建页)。签咕咕额度被拒时那台机器报的是原因码
 * (`gugu-models:<原因>`,#7103):按同一张原因表说,❌ 一律说成「连不上咕咕模型服务」。
 */
export function describeRemoteCreateFailure(code: string | null, device: string, translate: Translate): string {
  const gugu = guguReasonInText(code);
  return gugu ? guguReasonText(gugu, translate) : translate(CREATE_COPY[remoteFailureKind(code)], { device });
}

export type RemoteStartCondition = {
  code: 'start-failed' | 'auth-required' | 'harness-missing';
  label: string;
  /** 悬停看的:原因码(排查用)。 */
  detail: string;
  /** 这一行带不带「再试一次」。 */
  retry: boolean;
  /**
   * 这一行句子里那段「在这里登录」(#6264 在那台机器上登录这家):有就由面板接到登录窗口上。
   * `restart` = 登上之后顺手把这条没开起来的会话再开一次(人要的本来就是它开起来)。
   */
  signIn?: { label: string; restart: boolean };
};

/**
 * 这一家在那台机器上能不能从这里登录(面板按插件声明与宿主能力算好传进来):
 *  · `here` —— 声明了不靠回跳的登录,在咕咕里就能登;
 *  · `instructions` —— 这家有登录命令但只能到那台机器的终端里敲,点开看怎么登;
 *  · `null` —— 产品里没有这家的登录动作(或宿主给不了),只说事实。
 */
export type RemoteSignInReach = 'here' | 'instructions' | null;

const CONDITION_COPY: Partial<Record<RemoteFailureKind, Parameters<Translate>[0]>> = {
  'model-service-unreachable': 'remoteCondition.modelServiceUnreachable',
  'agent-signed-out': 'remoteCondition.agentSignedOut',
  'agent-runtime-missing': 'remoteCondition.agentRuntimeMissing',
  'agent-install-failed': 'remoteCondition.agentInstallFailed',
};

/** claude 没登录时回的那一句(作为 agent 的第一条回复出现在转录里)。 */
const SIGNED_OUT_REPLY = /^(?:not logged in|invalid api key)\b.*\/login/i;

function lastAssistantText(turns: readonly TranscriptTurn[]): string | null {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const items = turns[t]!.items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === 'message' && item.role === 'assistant') return item.text;
    }
  }
  return null;
}

/**
 * 会话打开了,转录末尾要不要挂一行说明 agent 那一侧的状况(断线那一行另算,优先于这一行):
 *  · 还没开起来 → 为什么(按原因码)+「再试一次」;正在重试时只说「正在重新开」;
 *  · 这一家的记录没接 → 说清到那台机器上去看,不给动作(重试修不好它);
 *  · agent 最近一句回复是「没登录」→ 指到那台机器上去登录(这台桌面替不了那台机器登录)。
 */
export function remoteStartCondition(input: {
  summary: Pick<SessionpageSessionSummary, 'recordState' | 'startFailure'> | null;
  /** 这一次「再试一次」的进展;`failed` 带机器新报的原因码。 */
  retry: { phase: 'idle' | 'running' | 'succeeded' } | { phase: 'failed'; code: string | null };
  turns: readonly TranscriptTurn[];
  device: string;
  agent: string;
  translate: Translate;
  /** 见 `RemoteSignInReach`;缺席 = null(老调用点)。 */
  signIn?: RemoteSignInReach;
  /** 这一轮已经在这里登上了(登录窗口报了成功)—— 「没登录」那句换成「已登录,再发一次」。 */
  signedIn?: boolean;
  /**
   * #6264 那台机器报这家「登录已失效」(凭据文件还在、最近一次真用时被拒)。转录读的是 harness 自己的
   * 会话记录,被拒的那一轮在那里看不出失败,所以这一格由那台机器的登录读数给。
   */
  harnessExpired?: boolean;
}): RemoteStartCondition | null {
  const { summary, retry, device, agent, translate } = input;
  const reach = input.signIn ?? null;
  const signInLabel = (restart: boolean) =>
    reach === 'here'
      ? translate(restart ? 'remoteCondition.signInAndRestart' : 'remoteCondition.signInHere')
      : translate('remoteCondition.signInHow');
  if (summary?.recordState === 'harness-unsupported') {
    return {
      code: 'harness-missing',
      label: translate('remoteCondition.harnessUnsupported', { device, agent }),
      detail: 'harness-unsupported',
      retry: false,
    };
  }
  if (summary?.recordState === 'not-started' && retry.phase !== 'succeeded') {
    if (retry.phase === 'running') {
      return { code: 'start-failed', label: translate('remoteCondition.retrying', { device }), detail: 'retrying', retry: false };
    }
    const code = retry.phase === 'failed' ? retry.code : (summary.startFailure ?? null);
    const gugu = guguReasonInText(code);
    if (gugu) {
      return { code: 'start-failed', label: guguReasonText(gugu, translate), detail: code ?? 'not-started', retry: guguReasonCopy(gugu).action === 'retry' };
    }
    const kind = remoteFailureKind(code ?? 'session_start_failed');
    // 没登录、而这里登得了:句子里那段字就是「登录并重新开始」,❌ 再挂一段「再试一次」(没登上重试也是白试)。
    if (kind === 'agent-signed-out' && reach) {
      return {
        code: 'start-failed',
        label: translate('remoteCondition.agentSignedOutLead', { device, agent }),
        detail: code ?? 'not-started',
        retry: false,
        signIn: { label: signInLabel(true), restart: true },
      };
    }
    const key = CONDITION_COPY[kind] ?? 'remoteCondition.startFailed';
    return { code: 'start-failed', label: translate(key, { device, agent }), detail: code ?? 'not-started', retry: true };
  }
  // #6264 最近一轮因为这家的登录不能用了而失败(结构化信号,见 session-runtime `isSignInFailure`):
  // 「登录已失效」+ 句子里那段「在这里登录它,再发一次」。
  if (input.harnessExpired || lastTurnSignInRequired(input.turns)) {
    if (input.signedIn) {
      return {
        code: 'auth-required',
        label: translate('remoteCondition.signedInSendAgain', { device, agent }),
        detail: 'sign-in-expired',
        retry: false,
      };
    }
    return {
      code: 'auth-required',
      label: translate(reach ? 'remoteCondition.agentSignInExpiredLead' : 'remoteCondition.agentSignInExpired', {
        device,
        agent,
      }),
      detail: 'sign-in-expired',
      retry: false,
      ...(reach ? { signIn: { label: signInLabel(false), restart: false } } : {}),
    };
  }
  const reply = lastAssistantText(input.turns);
  if (reply && SIGNED_OUT_REPLY.test(reply.trim())) {
    if (input.signedIn) {
      return {
        code: 'auth-required',
        label: translate('remoteCondition.signedInSendAgain', { device, agent }),
        detail: reply.trim(),
        retry: false,
      };
    }
    if (reach) {
      return {
        code: 'auth-required',
        label: translate('remoteCondition.agentSignedOutLead', { device, agent }),
        detail: reply.trim(),
        retry: false,
        signIn: { label: signInLabel(false), restart: false },
      };
    }
    return {
      code: 'auth-required',
      label: translate('remoteCondition.agentSignedOutReply', { device, agent }),
      detail: reply.trim(),
      retry: false,
    };
  }
  return null;
}
