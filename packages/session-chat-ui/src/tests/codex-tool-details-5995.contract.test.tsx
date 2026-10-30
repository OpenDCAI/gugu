import { decodeSessionUpdate } from '@gugu/session-core/acp';
/** @jsxImportSource solid-js */
import { expect, it } from 'vitest';
import { AcpTranscriptParser } from '@gugu/session-core/acp/transcript-parser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { until } from '../../../../tests/support/awaitCondition';

it('#5995 Codex tool payloads use the shared disclosure before and after view remount', async () => {
  const parser = new AcpTranscriptParser({ sessionId: 'codex-tools' });
  const names = ['cua_repl.js', 'gugu.message_rules', 'gugu.message_reply'];
  for (const [index, title] of names.entries()) {
    parser.pushEvent(decodeSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: `tool-${index}`,
      title,
      kind: 'other',
      status: 'completed',
      rawInput: { detail: `request-${index}` },
      rawOutput: index === 2
        ? [{ type: 'inputText', text: `result-${index}` }]
        : { content: [{ type: 'text', text: `result-${index}` }], structuredContent: null },
    }));
  }
  parser.endTurn();
  const ctx = createChatContext({ layout: { preset: 'single', userGutter: 0 } });
  const state = createChatState(ctx);
  state.transcript.history.seed([...parser.history]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:900px;';
  document.body.appendChild(host);
  let view = createChatView({ context: ctx, state, parent: host });
  const triggers = () => Array.from(host.querySelectorAll<HTMLElement>('[data-slot="tool-call-trigger"]'));
  try {
    // 行由虚拟列表在 viewHeight(ResizeObserver)到位后的调度帧里挂上 —— 等行出现,不数帧(#6346)。
    await until('tool rows mount', () => host.querySelector('[data-slot="tool-run"], [data-slot="tool-call-trigger"]') != null);
    const group = host.querySelector<HTMLElement>('[data-slot="tool-run"][data-expanded="false"] [data-collapse-id]');
    if (group) {
      group.click();
      // 展开 tool-run 由 flatten 在它下面重新发出原始行,新行随下一次投影挂上。
      await until('expanded tool run re-emits its tool rows', () => triggers().length >= 3);
    }
    expect(triggers()).toHaveLength(3);
    for (const [index, name] of names.entries()) {
      const trigger = () => triggers().find((element) => element.textContent?.includes(name))!;
      await until(`${name} starts collapsed`, () => trigger().getAttribute('aria-expanded') === 'false');
      expect(trigger().getAttribute('role')).toBe('button');
      expect(host.querySelector('[data-slot="tool-call-result"]')).toBeNull();
      trigger().click();
      await until(`${name} expands`, () => trigger().getAttribute('aria-expanded') === 'true');
      expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain(`request-${index}`);
      expect(host.querySelector('[data-slot="tool-call-result"]')?.textContent).toContain(`result-${index}`);
      trigger().click();
      // 收起时行在 200ms 高度 tween 里保持展开态(UnitRow 的 displayViewState),tween 结束 aria 才翻 —— 等它。
      await until(`${name} collapses`, () => trigger().getAttribute('aria-expanded') === 'false');
      expect(host.querySelector('[data-slot="tool-call-result"]')).toBeNull();
    }
    view.dispose();
    view = createChatView({ context: ctx, state, parent: host });
    await until('remounted view mounts the tool rows', () => triggers().length > 0);
    expect(triggers()[0].getAttribute('aria-expanded')).toBe('false');
    triggers()[0].click();
    await until('first tool expands after remount', () => triggers()[0].getAttribute('aria-expanded') === 'true');
    expect(host.querySelector('[data-slot="tool-call-result"]')?.textContent).toContain('result-0');
  } finally {
    view.dispose();
    state.dispose();
    ctx.dispose();
    host.remove();
  }
});
