/** @jsxImportSource solid-js */
/**
 * #4981 —— 复制按钮(最终回复的页脚)什么时候**不该**出现。
 *
 * owner 2026-09-06 截图:「派出」底下出了「复制消息」,可后台子智能体还在跑、后面还会来
 * 完成通知 —— 「这个怎么还有复制按钮,这不是在过程中吗」。runtime 那会儿已经报不忙了
 * (等后台子智能体时活动轮是空的),所以光看 `isGenerating` 不够。
 *
 * 两条判据,分别用一个只差一个自由度的对照钉住:
 *   1. 面板上还有在跑的后台子智能体 ⇒ 没有最终回复(通知一到就有);
 *   2. 最终回复必须是最后一行 —— 后面吊着过程行(比如完成通知)就还没完。
 */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { until } from '../../../../tests/support/awaitCondition';

const msg = (id: string, seq: number, role: ChatMessage['role'], text: string): ChatMessage => ({
  kind: 'message',
  id,
  seq,
  role,
  text,
});
/** 后台派发,启动这次调用本身已经完成(启动返回 ≠ 它跑完了)。 */
const launch = (seq: number) => ({
  kind: 'spawn-subagent-tool-call' as const,
  id: 'sp1',
  seq,
  toolCallId: 'sp1',
  title: '分析北京',
  name: '分析北京',
  status: 'done' as const,
  parentToolCallId: null,
  background: true,
});
/** 它跑完了的通知 —— 面板撤卡的唯一凭据。 */
const done = (seq: number) => ({
  kind: 'subagent-done-tool-call' as const,
  id: 'sp1-done',
  seq,
  toolCallId: 'task-notification:sp1',
  launchToolCallId: 'sp1',
  agentId: 'agent-sp1',
  title: '分析北京',
  name: '分析北京',
  status: 'done' as const,
  outcome: 'completed' as const,
  parentToolCallId: null,
});

function turnOf(items: unknown[]): TranscriptTurn {
  return {
    id: 't1',
    seq: 1,
    initiator: 'user',
    startedAt: Date.now() - 5_000,
    items: items as TranscriptTurn['items'],
    outcome: { kind: 'done' },
  };
}

async function copyButtonsFor(items: unknown[]): Promise<number> {
  const ctx = createChatContext();
  const state = createChatState(ctx);
  state.session.setGenerating(false);
  state.transcript.history.seed([turnOf(items)]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });
  // 数到 0 也要有完成事实(#6346):复制按钮是回复行 Render 的一部分,finalReplyId 是同步 memo ——
  // 回复行一挂上,它有没有复制按钮就定了。行由虚拟列表在 viewHeight(ResizeObserver)到位后挂上,等那一行,不数帧。
  const reply = (items as ChatMessage[]).filter((item) => item.kind === 'message' && item.role === 'assistant').at(-1)!;
  try {
    await until('the reply row mounts', () => host.textContent?.includes(reply.text) ?? false);
    const replyRow = host.querySelector<HTMLElement>(`[data-chat-canvas] [data-item-id="${CSS.escape(reply.id)}"]`);
    if (!replyRow) throw new Error('the assistant reply row did not mount');
    // User-message copying stays available even while a final reply is pending.
    expect(host.querySelector('[data-user-message-actions] button[aria-label="Copy message"]')).not.toBeNull();
    return replyRow.querySelectorAll('button[aria-label="Copy message"]').length;
  } finally {
    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  }
}

describe('#4981 复制按钮只给真正跑完后的最后一条回复', () => {
  it('阳控:问一句答一句,最后那条回复带复制按钮', async () => {
    expect(await copyButtonsFor([msg('u1', 0, 'user', '问'), msg('a1', 1, 'assistant', '答')])).toBe(1);
  });

  it('后台子智能体还在跑(派出去了、通知没来):没有复制按钮 —— 哪怕 runtime 说不忙', async () => {
    expect(
      await copyButtonsFor([msg('u1', 0, 'user', '派一个'), launch(1), msg('a1', 2, 'assistant', '派出')])
    ).toBe(0);
  });

  it('❌ 对照:只多一条完成通知(卡撤了),同一条回复就带复制按钮', async () => {
    expect(
      await copyButtonsFor([
        msg('u1', 0, 'user', '派一个'),
        launch(1),
        done(2),
        msg('a1', 3, 'assistant', '都回来了'),
      ])
    ).toBe(1);
  });

  it('回复后面还吊着过程行(完成通知落在它之后):它不是最后一行,不给复制按钮', async () => {
    expect(
      await copyButtonsFor([
        msg('u1', 0, 'user', '派一个'),
        launch(1),
        msg('a1', 2, 'assistant', '派出'),
        done(3),
      ])
    ).toBe(0);
  });
});
