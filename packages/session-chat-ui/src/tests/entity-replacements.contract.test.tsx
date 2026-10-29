/** @jsxImportSource solid-js */
import { AcpTranscriptParser, decodeSessionUpdate } from '@gugu/session-core/acp';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { planFromItem, planUnitDef } from '@session-chat/components/rows/plan/plan.def';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { SegmentCtx } from '@session-chat/core/units';
import { createChatState } from '@session-chat/state/chat-state';
import { describe, expect, it } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

function fixture() {
  const parser = new AcpTranscriptParser({ sessionId: 'replacement-dom' });
  let at = 100;
  return { parser, send: (update: Record<string, unknown>) => parser.pushEvent(decodeSessionUpdate(update as never), at++) };
}

it('replaces and clears mounted message text, and removes the specified mounted plan', async () => {
  const { parser, send } = fixture();
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:800px';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host });
  state.session.setGenerating(true);
  const apply = (update: Record<string, unknown>) => {
    send(update);
    state.session.setPlan(parser.plan);
    state.transcript.activeTurn.set(parser.activeTurn);
  };
  try {
    apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'Original longer answer' }] });
    await until('original answer mounted', () => host.textContent?.includes('Original longer answer') === true);
    apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'Short replacement' }] });
    await until('short replacement mounted', () => host.textContent?.includes('Short replacement') === true);
    expect(host.textContent).not.toContain('Original longer answer');
    apply({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'a', entries: [{ content: 'First plan entry', status: 'pending', priority: 'high' }] } });
    apply({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'b', entries: [{ content: 'Second plan entry', status: 'pending', priority: 'high' }] } });
    // The product groups adjacent plan updates into a tool-run; open that actual header.
    await until('plan tool-run mounted', () => host.querySelector('[data-row-kind="tool-run"] [data-collapse-id]') !== null);
    host.querySelector<HTMLElement>('[data-row-kind="tool-run"] [data-collapse-id]')!.click();
    await until('both plans mounted', () => ({ text: host.textContent ?? '', rows: [...host.querySelectorAll('[data-row-kind]')].map(e => e.getAttribute('data-row-kind')), items: state.transcript.activeTurn.get()?.items.map(item => item.kind) }), value => ['First plan entry', 'Second plan entry'].every(entry => value.text.includes(entry)));
    apply({ sessionUpdate: 'plan_removed', planId: 'a' });
    await until('one plan removed', () => !host.textContent?.includes('First plan entry'));
    expect(host.textContent).toContain('Second plan entry');
    apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [] });
    await until('cleared message leaves DOM', () => !host.textContent?.includes('Short replacement'));
    expect(host.textContent).toContain('Second plan entry');
  } finally {
    view.dispose(); state.dispose(); context.dispose(); host.remove();
  }
});

describe('plan body rendering', () => {
  it.each([
    { type: 'markdown', content: '# Native proposal\n\nA **formatted** plan.', expected: 'Native proposal' },
    { type: 'file', uri: 'file:///work/plan.md', expected: 'file:///work/plan.md' },
  ])('renders the native $type body belonging to its own id', async ({ expected, ...body }) => {
    const { parser, send } = fixture();
    send({ sessionUpdate: 'plan_update', plan: { planId: 'body', ...body } });
    send({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'other', entries: [{ content: 'Other plan', status: 'pending', priority: 'high' }] } });
    const marker = parser.activeTurn!.items.find(item => item.kind === 'create-plan-tool-call' && item.planId === 'body');
    if (marker?.kind !== 'create-plan-tool-call') throw new Error('plan marker was not produced');
    const ctx = { plan: () => parser.plan } as SegmentCtx;
    const data = planFromItem(marker, ctx);
    let text = '';
    const result = await renderAndMeasureUnit(planUnitDef, data, makeContractCtx({ width: 420 }), host => {
      text = host.textContent ?? '';
      return { childCount: host.children.length };
    });
    expect(text).toContain(expected);
    expect(text).not.toContain('Other plan');
    expect(result.dom).toBe(result.computed);
  });
});
