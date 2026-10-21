import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { ptyController } from '@main/core/pty/controller';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';

type InterruptResult = Awaited<ReturnType<typeof ptyController.interrupt>>;

export interface TuiTurnInterruptDeps {
  interrupt(ptySessionId: string): Promise<InterruptResult>;
  markInterrupted(params: { sessionId: string; projectId: string }): Promise<void>;
}

const defaultDeps: TuiTurnInterruptDeps = {
  interrupt: (ptySessionId) => ptyController.interrupt(ptySessionId),
  markInterrupted: (params) => agentStatusWriter.interrupt(params),
};

/**
 * 宿主替用户停掉终端腿当前这一轮:按这一家声明的中断键写进 pty,**然后由宿主自己把这一轮收成空闲**。
 *
 * 为什么宿主要自己收:中断是宿主发出的回合边界(spec hook-status-derivation「用户打断是停下、不是失败」),
 * 而不少 harness 被打断时**一条 hook 都不发** —— Antigravity `agy` 1.2.9 实测:Esc 之后约 55ms 模型请求被关、
 * 屏幕显示 Interrupted,但 Stop 钩子不触发(2026-09-24)。不收的话,权威行停在 `working`,直到下一轮的
 * Stop 才落回来:每一面(头像徽标、群汇总、运行条、本机会话投递的「回合在飞」判据)都说它还在干活。
 * 会发 Stop 的家也无害:打断只把在飞的抹成 idle、❌ 不写「做完未读」,
 * 之后迟到的 stop 看到的已经不在跑,同样不写未读(打断不是做完)。
 *
 * 返回值与 `cancelEmdashTurn` 的约定一致:true = 发出去了;false = 没有这条 pty / 不是会话;其余失败抛。
 */
export async function interruptTuiTurn(
  session: { id: string; projectId: string },
  deps: TuiTurnInterruptDeps = defaultDeps,
): Promise<boolean> {
  const ptySessionId = makePtySessionId(session.projectId, session.id, session.id);
  const result = await deps.interrupt(ptySessionId);
  if (result.success) {
    await deps.markInterrupted({
      sessionId: session.id,
      projectId: session.projectId,
    });
    return true;
  }
  if (result.error.type === 'not_found' || result.error.type === 'not_a_conversation') return false;
  throw new Error(
    `session-page cancel turn failed for ${session.id} on its native TUI leg: ${result.error.type}`,
  );
}
