/**
 * 手机看会话的工具卡:名字那一栏有一行的宽度可用,不被它自己的 45% 上限砍掉(owner 10-05 看 #6900 的效果页:
 * l3dice 那张待批卡只剩「r..」,经 catalog_call 跑的那张也只剩「l3-dice__…」)。
 * 名字 `<b>` 的 `max-w-[45%]` 是相对「名字 + 预览」那一栏算的;那一栏不撑满一行时,宽度就是它自己的内容,
 * 45% 等于把名字砍掉一半多。真 Chromium、真 CSS、手机视口;卡片走真路径:时间线条目 → toThreadMessages → ToolFallback。
 */
import { createRoot, type Root } from 'react-dom/client';
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ToolFallback } from '@/components/assistant-ui/tool-fallback.aui';
import { toThreadMessages } from '@/mobile/agent-watch/thread-messages';
import '@/i18n';
import '@/styles/tokens.css';

const mcpCall = (id: string, server: string, tool: string, rawInput: unknown) =>
  ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: `mcp__${server}__${tool}`, status: 'done', server, tool, rawInput: JSON.stringify(rawInput) }) as unknown as TranscriptTurn['items'][number];

function Cards({ messages }: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages, convertMessage: (message) => message, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages>{() => <MessagePrimitive.Parts components={{ tools: { Fallback: ToolFallback } }} />}</ThreadPrimitive.Messages>
    </AssistantRuntimeProvider>
  );
}

let root: Root | null = null;
beforeEach(() => page.viewport(412, 842));
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

it('a short tool name is shown whole, with or without a preview after it', async () => {
  const turn = {
    id: 't1',
    seq: 1,
    initiator: 'user',
    items: [mcpCall('i1', 'l3dice', 'roll', { sides: 20 }), mcpCall('i2', 'gugu', 'catalog_call', { tool: 'l3-dice__roll', args: {} })],
  } as TranscriptTurn;
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(<Cards messages={toThreadMessages([turn])} />);
  const names = () => [...document.querySelectorAll<HTMLElement>('[data-slot="tool-fallback-trigger-label"] b')];
  await until('both cards are drawn', () => names().length === 2);
  expect(names().map((name) => name.textContent)).toEqual(['roll', 'l3-dice__roll']);
  for (const name of names()) {
    expect.soft(name.scrollWidth, `「${name.textContent}」 is not cut`).toBeLessThanOrEqual(name.clientWidth);
  }
});

// L11 复核 52:没有预览的卡,名字有一整行可用 —— 45% 只在后面跟着预览时才管它;比一行还长的名字在这一行里截,❌ 伸到箭头上。
it('without a preview a long name has the whole row, and a name longer than the row is cut inside it', async () => {
  const fits = 'group-vote__cast_vote_with_reason';
  const tooLong = `group-vote__${'cast_vote_with_a_very_long_reason_'.repeat(4)}`;
  const turn = {
    id: 't1',
    seq: 1,
    initiator: 'user',
    items: [mcpCall('i1', 'gugu', 'catalog_call', { tool: fits, args: {} }), mcpCall('i2', 'gugu', 'catalog_call', { tool: tooLong, args: {} })],
  } as TranscriptTurn;
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(<Cards messages={toThreadMessages([turn])} />);
  const labels = () => [...document.querySelectorAll<HTMLElement>('[data-slot="tool-fallback-trigger-label"]')];
  await until('both cards are drawn', () => labels().length === 2);
  const [short, long] = labels().map((label) => ({ label, name: label.querySelector<HTMLElement>('b')! }));
  expect.soft(short.name.scrollWidth, `「${fits}」 is not cut`).toBeLessThanOrEqual(short.name.clientWidth);
  expect.soft(long.name.scrollWidth, 'the too-long name is cut').toBeGreaterThan(long.name.clientWidth);
  expect.soft(long.name.getBoundingClientRect().right, 'and stays inside its row').toBeLessThanOrEqual(long.label.getBoundingClientRect().right + 0.5);
});
