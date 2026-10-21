import { err, ok } from '@gugu/session-shared';
import { ptyOutputActivity } from './pty-output-activity';
import { ptySessionRegistry } from './pty-session-registry';

/**
 * 把一次提问回答的键序逐拍写进会话的 pty(#6798)。与 `ptyController.interrupt` 同一条路:同一张注册表、
 * 只写会话 pty(有 providerId 的那种)、每拍重核 pty 身份。键序与节拍由这家的声明给出,本函数只按拍子写字节。
 * 不挂在 RPC controller 上 —— `stillOpen` 过不了 IPC,渲染层也没有理由直接往选择器里写键。
 *
 * 不变量:
 *  · 选择器只开在问出这道题的那一代 agent 进程里。这一代是题目问出来之后才起的(没开 tmux 时 app 重启、
 *    会话被 resume)⇒ 屏幕上没有这道题,记录里它却永远等不到结果 —— 一个键都不写。
 *  · 每一拍之前问 `stillOpen()`(选择器还开着);不成立立刻停,剩下的键一个不写。选择器关了还写,
 *    数字会打进输入框、Esc 会打断 agent 正在干的活。
 *  · 一拍 = 一次 write,写完等终端重画完(这一拍之后出过字,且连续 `settleMs` 没有新字节)再写下一拍;
 *    `maxWaitMs` 内等不到就停。挤在一次 write 里的键会被选择器丢掉,而且是静默答错。
 *  · 「最后一个字节何时」读 `pty-output-activity`,❌ 另挂 onData(见那个文件的理由)。
 */
export async function writeKeyBeats(
  ptySessionId: string,
  writes: readonly string[],
  pacing: { settleMs: number; maxWaitMs: number },
  question: { askedAt: number | undefined; stillOpen: () => Promise<boolean> }
) {
  const pty = ptySessionRegistry.get(ptySessionId);
  if (!pty) return err({ type: 'not_found' as const, written: 0 });
  const metadata = ptySessionRegistry.getMetadata(ptySessionId);
  if (!metadata?.providerId) return err({ type: 'not_a_conversation' as const, written: 0 });
  const { askedAt, stillOpen } = question;
  if (metadata.agentStartedAt !== undefined && askedAt !== undefined && metadata.agentStartedAt > askedAt) {
    return err({ type: 'question_gone' as const, written: 0 });
  }

  let written = 0;
  for (const data of writes) {
    if (!(await stillOpen())) return err({ type: 'question_closed' as const, written });
    // 身份在等完 stillOpen 之后再核:那一段 await 里 agent 可能已经重启成新进程。
    if (ptySessionRegistry.get(ptySessionId) !== pty) return err({ type: 'not_found' as const, written });
    const writtenAt = Date.now();
    pty.write(data);
    written += 1;
    let settled = false;
    while (!settled && Date.now() - writtenAt < pacing.maxWaitMs) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pacing.settleMs));
      const lastDataAt = ptyOutputActivity(pty)?.lastDataAt ?? 0;
      settled = lastDataAt >= writtenAt && Date.now() - lastDataAt >= pacing.settleMs;
    }
    if (!settled) return err({ type: 'render_timeout' as const, written });
  }
  return ok({ written });
}
