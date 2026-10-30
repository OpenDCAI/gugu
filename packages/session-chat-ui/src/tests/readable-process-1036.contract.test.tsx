import { createChatContext } from '@session-chat/chat-context';
import { createChatState } from '@session-chat/state/chat-state';
import { createChatView } from '@session-chat/chat-view';
import { pinSticky } from '@session-chat/chat-root.css';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { describe, expect, it } from 'vitest';
import { turnProcessUnitDef } from '@session-chat/components/rows/turn-process/turn-process.def';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import { openedOutputUnitDef } from '@session-chat/components/rows/opened-output/opened-output.def';
import { fileChangeSummaryUnitDef } from '@session-chat/components/rows/file-change-summary/file-change-summary.def';
import { resourceLinkUnitDef } from '@session-chat/components/rows/resource-link/resource-link.def';
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def';
import { toolRunUnitDef } from '@session-chat/components/rows/tool-run/tool-run.def';
import { sessionNoticeUnitDef } from '@session-chat/components/rows/boundary/session-notice.def';
import { backgroundTasksUnitDef } from '@session-chat/components/rows/background-tasks/background-tasks.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

/** Text must fit its painted box, not merely survive in textContent/title. */
function textBounds(host: HTMLElement) {
  let hidden = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      for (const rect of range.getClientRects()) {
        for (let parent = node.parentElement; parent && parent !== host.parentElement; parent = parent.parentElement) {
          const box = parent.getBoundingClientRect();
          const css = getComputedStyle(parent);
          let clipped = 0;
          if (['hidden', 'clip'].includes(css.overflowX)) clipped = Math.max(clipped, rect.right - box.right, box.left - rect.left);
          if (['hidden', 'clip'].includes(css.overflowY)) clipped = Math.max(clipped, rect.bottom - box.bottom);
          hidden = Math.max(hidden, clipped);
        }
      }
    }
  }
  return { hidden };
}

describe('readable process rows at real split-column widths (#1036)', () => {
  for (const width of [198, 430, 724]) {
    it(`shows the complete process summary at ${width}px`, async () => {
      const result = await renderAndMeasureUnit(toolRunUnitDef, {
        kind: 'tool-run', id: 'summary', turnId: 't', stepCount: 8,
        label: 'Thought 1 time, read 3 files, ran 3 shell commands, called 1 MCP tool',
      }, makeContractCtx({ width }), textBounds);
      expect(result.inspected.hidden).toBeLessThanOrEqual(1);
      expect(result.dom).toBe(result.computed);
      expect(result.spill).toBeLessThanOrEqual(1);
    });
  }

  for (const width of [198, 430, 724]) {
    it(`shows the running head and attached background at ${width}px`, async () => {
      const ctx = makeContractCtx({ width, theme: { ...DEFAULT_THEME, layout: { ...DEFAULT_THEME.layout, agentConversation: true } } });
      ctx.background = { ownerId: 'running', commands: [{ id: 'c', launchToolCallId: 'c', taskId: 'bg', name: 'sleep 150' }], subagents: [], expanded: false };
      const result = await renderAndMeasureUnit(turnProcessUnitDef, {
        kind: 'turn-process', id: 'running', turnId: 't', live: true, steps: 7, startedAt: Date.now() - 39000,
      }, ctx, textBounds);
      expect(result.inspected.hidden).toBeLessThanOrEqual(1);
      expect(result.dom).toBe(result.computed);
      expect(result.spill).toBeLessThanOrEqual(1);
    });
  }

  it('wraps a notification that has no full-text disclosure', async () => {
    const result = await renderAndMeasureUnit(sessionNoticeUnitDef, {
      kind: 'session-notice', id: 'notice', seq: 1, code: 'provider-notice',
      title: 'The selected runtime is unavailable and this task is using the confirmed replacement runtime.', detail: '',
    }, makeContractCtx({ width: 198 }), textBounds);
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
  });

  it('shows a long background command and reserves its wrapped height', async () => {
    const result = await renderAndMeasureUnit(backgroundTasksUnitDef, {
      kind: 'background-tasks', id: 'background', expanded: true,
      commands: [{ id: 'c', launchToolCallId: 'c', taskId: 'task', name: "sleep 150; printf '%s\\n' 'T1036-BACKGROUND-WITH-A-LONG-OBSERVABLE-COMMAND-END'" }],
      subagents: [],
    }, makeContractCtx({ width: 198 }), textBounds);
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
    expect(result.spill).toBeLessThanOrEqual(1);
  });

  it('wraps a static output title and unavailable explanation', async () => {
    const result = await renderAndMeasureUnit(openedOutputUnitDef, {
      kind: 'opened-output', id: 'out', turnId: 't', index: 0, count: 1,
      output: { kind: 'file', path: '/workspace/complete-output-filename-that-must-not-be-cut.html' },
    }, makeContractCtx({ width: 198 }), textBounds, {
      outputUnavailable: () => 'This file can only be opened on its original computer.',
    });
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
  });

  it('wraps the result title and path even without a file-opening callback', async () => {
    const result = await renderAndMeasureUnit(fileChangeSummaryUnitDef, {
      kind: 'file-change-summary', id: 'files', turnId: 't', adds: 2, dels: 1,
      files: [{ path: '/workspace/complete-file-path-that-must-remain-readable.ts', adds: 2, dels: 1, diffs: [] }],
    }, makeContractCtx({ width: 198 }), textBounds);
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
  });

  it('wraps an opaque resource title and URI with no click target', async () => {
    const result = await renderAndMeasureUnit(resourceLinkUnitDef, {
      kind: 'resource-link', id: 'resource', uri: 'custom://complete-resource-path-that-cannot-be-opened',
      name: 'Complete resource title without a disclosure', target: { kind: 'opaque' },
    }, makeContractCtx({ width: 198 }), textBounds);
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
  });

  it('wraps an outcome reason even when no provider-detail disclosure exists', async () => {
    const result = await renderAndMeasureUnit(turnOutcomeUnitDef, {
      kind: 'turn-outcome', id: 'outcome', turnId: 't', outcome: { kind: 'error', reason: 'prompt_failed' },
    }, makeContractCtx({ width: 198 }), textBounds);
    expect(result.inspected.hidden).toBeLessThanOrEqual(1);
    expect(result.dom).toBe(result.computed);
  });
});


it('unpins a tall question when the column narrows, restores short pins, and rechecks viewport height', async () => {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 32, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:748px;height:850px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, pinUserMessages: true, stickToBottom: false });
  try {
    state.transcript.history.seed([{ id: 'pin', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'question', seq: 0, role: 'user', text: 'Read the three local files and run the verified local commands. '.repeat(10) },
      { kind: 'message', id: 'answer', seq: 1, role: 'assistant', text: 'FIRST-REPLY-LINE\n\n' + 'The reply stays readable below the question.\n\n'.repeat(20) },
    ] }]);
    const question = () => host.querySelector<HTMLElement>('[data-item-id="question"]');
    const pinned = () => !!question()?.closest(`.${pinSticky}`);
    const scroll = () => host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    await until('the wide question is pinned', pinned);
    host.style.width = '222px';
    await until('the narrow question leaves the pin lane', () => !!question() && !pinned());
    view.scrollToItem('answer', { align: 'start' });
    await until('the answer is rendered', () => !!host.querySelector('[data-agent-conversation-message="answer"]'));
    await untilStable('narrow reply geometry', () => [scroll().scrollTop, scroll().scrollHeight]);
    const reply = host.querySelector<HTMLElement>('[data-agent-conversation-message="answer"]')!;
    const line = reply.querySelector<HTMLElement>('p')!.getBoundingClientRect();
    expect(reply.contains(document.elementFromPoint(line.left + 8, Math.max(line.top + 8, 12)))).toBe(true);
    host.style.width = '748px';
    view.scrollToTop();
    await until('widening restores the pin', pinned);
    host.style.height = '140px';
    await until('shortening the viewport removes the tall pin', () => !pinned());
    host.style.height = '850px';
    await until('growing the viewport restores the pin', pinned);
  } finally { view.dispose(); state.dispose(); context.dispose(); host.remove(); }
});
