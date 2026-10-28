import { questionAnswerError } from '@gugu/session-core/session-record';
import { getAcpRuntimeClient } from '@main/core/acp/runtime-process/host';
import { readAcpSessionSummaries } from '@main/core/acp/session-summary-reader';
import { sendMessage } from '@main/core/sessions/sendMessage';
import type { Session } from '@shared/core/sessions/sessions';
import {
  remoteSettlementGap,
  type QuestionAnswer,
  type Settlement,
  type SettlementQuestion,
} from '@gugu/session-core/session-record/contract';
import { getPlugin, isValidProviderId } from '@main/core/agents/plugin-registry';
import { writeKeyBeats } from '@main/core/pty/answer-question';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { log } from '@main/lib/logger';

/**
 * 写侧：把「发一条用户消息」「回答一个权限请求」这两件事接到**本仓真实存在的**入口上。
 *
 * 读侧（时间线）是 harness 自己的记录，与咕咕怎么把它拉起来无关；写侧不是 —— 它必须走
 * 这条会话当初被拉起来的那条腿：
 *
 *  · 用户消息：ACP 与 TUI 都走 `sendMessage`（`core/sessions/sendMessage.ts`），由既有路由按
 *    harness 的能力决定忙时插话；不在手机写侧另写一条 ACP 准入/唤醒/排队链路。
 *    TUI ❌ 不直接 `ptyController.sendInput(text + '\r')`：那会绕开
 *    `buildPromptInjectionPayload`（换行/括号粘贴按家转义）与各家声明的 `submitSequence`/`submitDelayMs`，
 *    也绕开 `prompt.kind: 'none'` 那条 fail loud。同一段字节两处编码，迟早分叉。
 *  · ACP 审批：`getAcpRuntimeClient().resolvePermission`。
 *
 * 权限请求在 TUI 腿上**没有通道**：那是画在终端里的一屏文字，没有 item id、没有结算口。
 * 这里如实抛 `no_permission_channel`，❌ 不按 optionId 猜一个按键写进 pty 冒充「已回答」。
 * 提问(AskUserQuestion)是例外(#6798、#7035):声明了 `sessionTuiQuestionAnswer` 的家,往 pty 写一次它的取消键
 * 关掉选择器,再把回答当一条消息发过去 —— 取消键是这家声明、取过证的,不是猜。
 */

export class SessionWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionWriteError';
    this.code = code;
  }
}

/**
 * 写侧目标就是一条**完整的** `Conversation`。
 * ❌ 不收「够用的那几个字段」再 `as Conversation` —— 注入路径读的是这个类型，
 * 它哪天多读一个字段，投影版给出的是 undefined 而类型说它在。
 */
export type SessionWriteTarget = Session;

/**
 * 「唤醒」一条不活的 ACP 会话:桌面端的 `ensureEmdashSession`(embedded-boot)—— 按存下来的
 * provider sessionId 把引擎进程重新拉起来(claude `--resume` 那条)。
 *
 * 注入而不是 import:embedded-boot 引着 session-timeline 这条链,反向直接引会成环
 * (与 `setSessionStatusFeed` 同一条理由)。没注入时如实报 `session_not_live`。
 *
 * 为什么非做不可(owner 2026-09-06 真机):app 重启过一次之后,手机上回复任何一条老会话都报
 * 「这条没发出去 <会话id> (send_failed)」—— ACP 运行时里已经没有这条会话,promptDetached 直接抛。
 * 桌面端点进同一条会话会自动唤醒再发,手机端不该比桌面端少这一步。
 */
type SessionWake = (sessionId: string) => Promise<void>;
let sessionWake: SessionWake | null = null;
export function setSessionWake(wake: SessionWake | null): void {
  sessionWake = wake;
}

/**
 * 「停掉当前这一轮」:桌面端的 `cancelEmdashTurn`(embedded-boot)—— ACP 腿走协议 cancel,
 * 终端腿按这家 descriptor 声明的中断键写 pty(没声明就 fail loud,❌ 回落 Ctrl-C)。
 * 同样注入(成环理由同上)。没注入如实报 `cancel_unavailable`。
 */
type SessionCancel = (sessionId: string) => Promise<boolean>;
let sessionCancel: SessionCancel | null = null;
export function setSessionCancel(cancel: SessionCancel | null): void {
  sessionCancel = cancel;
}

export async function deliverSessionCancel(target: SessionWriteTarget): Promise<{ cancelled: boolean }> {
  if (!sessionCancel) {
    throw new SessionWriteError('cancel_unavailable', '主进程还没接上「停止」这条通道');
  }
  return { cancelled: await sessionCancel(target.id) };
}

/**
 * 这条 ACP 会话在运行时里活着吗。`starting` 也算活:再拉一次只会撞上正在起的那个。
 * `lost`(适配器自己退了:崩溃、被停)不算活(编号 5,10-12 片场试演):唤醒对它和对 `closed` 一样起会话,
 * 运行时按丢掉的那条接回原会话(session-manager.ts `start` 的 lost 分支)—— 任务页的「Reconnect」走的也是它。
 */
export async function acpSessionLive(sessionId: string): Promise<boolean> {
  const summaries = await readAcpSessionSummaries();
  const summary = Object.values(summaries).find((s) => s.sessionId === sessionId);
  return !!summary && !summary.closing && summary.lifecycle !== 'closed' && summary.lifecycle !== 'lost';
}

/** 导出给读会话参数那条路:参数住在活运行时里,不活先按桌面同一条「唤醒」拉起来,再读。 */
export async function ensureAcpSessionLive(sessionId: string): Promise<void> {
  if (await acpSessionLive(sessionId)) return;
  if (!sessionWake) {
    throw new SessionWriteError(
      'session_not_live',
      '这条会话在那台机器上已经没有在跑的 agent,而这台机器没有接唤醒通道'
    );
  }
  try {
    await sessionWake(sessionId);
  } catch (error) {
    throw new SessionWriteError(
      'session_wake_failed',
      `这条会话的 agent 已经不在了,重新拉起也失败了:${(error as Error)?.message ?? String(error)}`
    );
  }
}

/**
 * 一条用户消息进这条会话。返回即「provider 受理了」，❌ 不等整轮跑完（手机那头等不起）。
 */
export async function deliverSessionText(
  target: SessionWriteTarget,
  text: string
): Promise<{ accepted: 'started' | 'queued' }> {
  const body = text.trim();
  if (!body) throw new SessionWriteError('empty_text', '消息是空的');

  // `runtime === null` 就是 pty:终端腿是默认形态,建会话时那一列常常没写。
  // 直接判 `=== 'pty'` 会把活着的终端会话漏到下面的 unsupported_runtime。
  //
  // ⚠️ 走**既有的** `sendMessage` —— 桌面端自己发消息就走它,它自带 runtime 分派、
  //    幂等(clientMessageId)与收据。
  // ❌ 别自己 `ptySessionRegistry.get(makePtySessionId(...))` 去捞 pty:那张表装的是
  //    **终端面板**的 pty(`local-terminal-provider` 按 `terminal.id` 注册),而**会话**的 pty
  //    在 conversation provider 自己的 `sessions` 里。两张表都用 makePtySessionId 造 key、
  //    长得一模一样,查错了不报错 —— 只会永远 `session_not_live`。实测:一条刚建的、
  //    桌面上正在跑的会话也被判成死的,手机端给 TUI 腿发消息从来没成功过。
  if (target.runtime === 'acp' || target.runtime === 'pty' || target.runtime === null) {
    const params = {
      projectId: target.projectId,
      sessionId: target.id,
      clientMessageId: `mobile-${target.id}-${Date.now()}`,
      text: body,
      kind: 'session-direct' as const,
      ...(target.runtime === 'acp' ? { delivery: { queue: true as const, origin: 'manual' as const } } : {}),
    };
    // 冷着的终端腿(app 重启后没起、被停过)由 session-direct 的路由自己唤醒再投(#6546),
    // 这里 ❌ 再拉一遍 —— owner 2026-09-06 真机撞的那格(codex 终端腿)现在走的是同一条恢复。
    const result = await sendMessage(params);
    if (result.status === 'outcome-unknown') {
      throw new SessionWriteError('session_not_live', '这条会话没有接住这条消息(投递结果未知)');
    }
    return { accepted: result.status === 'queued' ? 'queued' : 'started' };
  }

  throw new SessionWriteError(
    'unsupported_runtime',
    `这条会话的运行时是 ${String(target.runtime)}，主进程没有往它发消息的通道`
  );
}

/**
 * 这一项在这条腿上有没有结算口;没有就给出要抛的错。判据是 `remoteSettlementGap`(手机卡片读的同一条)。
 * `respond` 在抢结算**之前**就问它 —— 先抢成 resolved 推出去再放回,推出去的那一下在手机上就是
 * 一句「已在手机端回答」(#6739)。
 */
export function permissionChannelError(
  target: SessionWriteTarget,
  kind: 'permission' | 'question',
  questions?: Settlement['questions']
): SessionWriteError | null {
  const gap = remoteSettlementGap(target.runtime, kind, questions);
  if (gap === 'no_permission_channel') {
    return new SessionWriteError(
      gap,
      `${String(target.runtime)} 腿上没有权限回答通道：审批画在终端里，没有可结算的请求 id。`
        + ' 请在这台机器的终端里回答，或给这家开 Chat UI（ACP 腿）。'
    );
  }
  if (gap === 'no_question_channel') {
    // 提问（`question`）在 ACP 上不是 requestPermission，本仓今天没有对应的主进程结算口。
    return new SessionWriteError(gap, 'ACP 腿今天只有权限请求可以从宿主结算；提问类项还没有主进程入口');
  }
  return null;
}

/** 回答一个权限请求(ACP 腿)。提问走 `deliverQuestionAnswer`。 */
export async function deliverPermissionDecision(
  target: SessionWriteTarget,
  input: { itemId: string; optionId: string }
): Promise<void> {
  const unavailable = permissionChannelError(target, 'permission');
  if (unavailable) throw unavailable;
  const client = await getAcpRuntimeClient();
  const result = await client.resolvePermission({
    sessionId: target.id,
    requestId: input.itemId,
    optionId: input.optionId,
  });
  if (!result.success) {
    throw new SessionWriteError(
      'resolve_permission_failed',
      `ACP 拒绝了这次权限结算：${result.error.type}`
    );
  }
}

export type PreparedQuestionAnswer = {
  /** 关掉选择器的那个键,与这家声明的重画节拍。 */
  cancel: { key: string; settleMs: number; maxWaitMs: number };
  /** 发给 agent 的回答;拒答 = null(只关选择器)。 */
  text: string | null;
};

/** 写完取消键之后,最多等这么久让记录里出现这道题的结果(毫秒)。 */
const QUESTION_CLOSE_WAIT_MS = 10_000;
const QUESTION_CLOSE_POLL_MS = 200;

/**
 * 终端提问的回答(#6798、#7035)。在认领结算、写任何字节**之前**调:这家没声明取消键 ⇒ `no_question_channel`;
 * 回答和题目对不上 ⇒ `answer_invalid`。
 */
export function prepareQuestionAnswer(
  target: SessionWriteTarget,
  questions: readonly SettlementQuestion[],
  answer: readonly QuestionAnswer[] | 'decline'
): PreparedQuestionAnswer {
  const plugin = isValidProviderId(target.providerId) ? getPlugin(target.providerId) : null;
  const declared = plugin?.capabilities.sessionBundle.sessionTuiQuestionAnswer;
  if (!declared) {
    throw new SessionWriteError('no_question_channel', `${target.providerId} 没有声明终端提问的取消键,请在终端里回答`);
  }
  return {
    cancel: { key: declared.cancel, settleMs: declared.settleMs, maxWaitMs: declared.maxWaitMs },
    text: answer === 'decline' ? null : questionAnswerText(questions, answer),
  };
}

/**
 * 把手机上的回答写成发给 agent 的一句话。每题一行:题目 → 选中的选项,自己写的另起一段标明。
 * 回答与题目对不上(份数不同、选了不存在的选项、一题什么都没答)⇒ `answer_invalid`,❌ 猜着补。
 */
export function questionAnswerText(questions: readonly SettlementQuestion[], answers: readonly QuestionAnswer[]): string {
  if (answers.length !== questions.length) {
    throw new SessionWriteError('answer_invalid', `答案有 ${answers.length} 份,题目有 ${questions.length} 道`);
  }
  const invalid = questionAnswerError(questions, answers);
  if (invalid) throw new SessionWriteError('answer_invalid', invalid);
  const lines = questions.map((question, index) => {
    const { selected, other } = answers[index];
    const labels = question.options.map((option) => option.optionId);
    const unknown = selected.find((label) => !labels.includes(label));
    if (unknown !== undefined) throw new SessionWriteError('answer_invalid', `「${unknown}」不是第 ${index + 1} 题的选项`);
    const typed = other?.trim();
    // 多选一项都不勾是合法回答;单选必须有一个选项或自己写的一段。
    if (selected.length === 0 && !typed && !question.multiSelect) {
      throw new SessionWriteError('answer_invalid', `第 ${index + 1} 题没有回答`);
    }
    const parts = [...(selected.length > 0 ? [selected.join('、')] : []), ...(typed ? [`(我自己写的)${typed}`] : [])];
    if (parts.length === 0) parts.push('(一项都没选)');
    return `- ${question.question} → ${parts.join(';')}`;
  });
  return ['我在咕咕的提问卡里回答了你刚才的提问(终端里的选择框已经替我关掉了):', ...lines].join('\n');
}

/**
 * 回答一道终端提问:往 pty 写一次取消键 → 等记录里这道题有了结果 → 有回答就当一条消息发过去。
 * `stillOpen` 由调用方给(记录读到文件尾、这道题还没有结果);`askedAt` 是记录里问出这道题的时刻。
 * 失败时带回取消键写进去没有(`written`)。
 */
export async function deliverQuestionAnswer(
  target: SessionWriteTarget,
  prepared: PreparedQuestionAnswer,
  question: { askedAt: number | undefined; stillOpen: () => Promise<boolean> }
): Promise<{ ok: true } | { ok: false; error: SessionWriteError; written: number }> {
  const ptySessionId = makePtySessionId(target.projectId, target.id, target.id);
  const { key, settleMs, maxWaitMs } = prepared.cancel;
  const result = await writeKeyBeats(ptySessionId, [key], { settleMs, maxWaitMs }, question);
  if (!result.success) {
    const { type, written } = result.error;
    const message = {
      not_found: '这条会话的终端已经不在了',
      not_a_conversation: '这不是一条 agent 会话的终端',
      question_closed: '终端里的选择器已经关了(在终端里答过、拒过,或这一轮被停了)',
      question_gone: '这道题问出来之后终端里的 agent 重启过,选择器已经不在了',
      render_timeout: '写了取消键之后终端没有重画',
    }[type];
    return { ok: false, error: new SessionWriteError(type === 'not_found' ? 'session_not_live' : type, message), written };
  }
  // 选择器关掉、记录里落下这道题的结果之后再发:先发的话,这句话会进到还开着的选择器里。
  const deadline = Date.now() + QUESTION_CLOSE_WAIT_MS;
  while (await question.stillOpen()) {
    if (Date.now() > deadline) {
      return {
        ok: false,
        error: new SessionWriteError('question_still_open', `写了取消键 ${QUESTION_CLOSE_WAIT_MS / 1000}s 后,记录里这道题还没有结果`),
        written: 1,
      };
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, QUESTION_CLOSE_POLL_MS));
  }
  if (prepared.text === null) return { ok: true };
  try {
    await deliverSessionText(target, prepared.text);
  } catch (error) {
    log.warn('[session-timeline] 终端提问的选择器已关,回答没有发出去', {
      sessionId: target.id,
      code: error instanceof SessionWriteError ? error.code : undefined,
      error: (error as Error)?.message ?? String(error),
    });
    return {
      ok: false,
      error: new SessionWriteError('answer_not_delivered', '选择框已经关了,但回答没有发到 agent,请直接给它发一条消息'),
      written: 1,
    };
  }
  return { ok: true };
}
