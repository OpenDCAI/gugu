import { decodeSessionUpdate } from '@gugu/session-core/acp';
/** @jsxImportSource solid-js */
import { expect, it } from 'vitest';
import { AcpTranscriptParser } from '@gugu/session-core/acp/transcript-parser';
import { createClaudeSessionDecoder } from '../../../session-plugins/src/agents/impl/claude/acp-transform';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';
import type { ItemNode } from '@session-chat/state/flatten';
import { until } from '../../../../tests/support/awaitCondition';

const decodeClaudeSessionUpdate = createClaudeSessionDecoder();


it('native Codex child reasoning and results expand inside the existing subagent disclosure', async () => {
  const parser = new AcpTranscriptParser({ sessionId: 'native-subagent' });
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit native', task: 'Audit native', background: true, request: 'NATIVE_REQUEST' }));
  for (const [sessionUpdate, text] of [['agent_thought_chunk', 'NATIVE_REASONING'], ['agent_message_chunk', 'NATIVE_RESULT']]) {
    parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: { sessionUpdate, content: { type: 'text', text } } }));
  }
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }));
  parser.endTurn();
  const ctx = createChatContext({ locale: () => 'en-US', layout: { preset: 'single', userGutter: 0 } });
  const state = createChatState(ctx);
  state.transcript.history.seed([...parser.history]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:1200px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });
  const trigger = () => [...host.querySelectorAll<HTMLElement>('[data-slot="tool-call-trigger"]')].find((element) => element.textContent?.includes('Audit native'));
  try {
    await until('native subagent mounts', () => host.querySelector('[data-slot="tool-run"], [data-slot="tool-call-trigger"]') != null);
    host.querySelector<HTMLElement>('[data-slot="tool-run"][data-expanded="false"] [data-collapse-id]')?.click();
    await until('native launch is visible', () => trigger()?.getAttribute('aria-expanded') === 'false');
    expect(host.querySelector('[data-slot="tool-call-reasoning"]')).toBeNull();
    trigger()!.click();
    await until('child details expand', () => host.querySelector('[data-slot="tool-call-reasoning"]') != null);
    expect(host.querySelector('[data-slot="tool-call-reasoning"]')?.textContent).toContain('NATIVE_REASONING');
    expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('NATIVE_REQUEST');
    expect(host.querySelector('[data-slot="tool-call-result"]')?.textContent).toContain('NATIVE_RESULT');
    const panel = host.querySelector<HTMLElement>('[data-slot="tool-call-reasoning"]')!;
    expect(panel.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.parentElement!.getBoundingClientRect().bottom + 1);
  } finally { view.dispose(); state.dispose(); ctx.dispose(); host.remove(); }
});

it.each([false, true])('#6020 subagent details use shared disclosure, including children: %s', async (withChild) => {
  const parser = new AcpTranscriptParser({ sessionId: 'subagent-details' });
  parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'parent', title: 'inspect files', kind: 'other',
    status: withChild ? 'failed' : 'completed',
    rawInput: { description: 'inspect files', prompt: 'FULL_PROMPT_DETAIL', model: 'worker-model' },
    rawOutput: { message: withChild ? 'FAILURE_DETAIL' : 'SUCCESS_DETAIL' },
    _meta: { claudeCode: { toolName: 'Agent', toolResponse: { agentId: 'native-child' } } } }));
  if (withChild) parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'child', title: 'child lookup', kind: 'other',
    status: 'completed', rawInput: { query: 'CHILD_ARGUMENT' }, rawOutput: 'CHILD_RESULT',
    _meta: { claudeCode: { parentToolUseId: 'parent' } } }));
  parser.endTurn();
  const ctx = createChatContext({ locale: () => 'en-US', layout: { preset: 'single', userGutter: 0 } });
  const state = createChatState(ctx);
  state.transcript.history.seed([...parser.history]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:1200px;';
  document.body.appendChild(host);
  let view = createChatView({ context: ctx, state, parent: host });
  const trigger = () => Array.from(host.querySelectorAll<HTMLElement>('[data-slot="tool-call-trigger"]'))
    .find((element) => element.textContent?.includes('inspect files'))!;
  try {
    // 行由虚拟列表在 viewHeight(ResizeObserver)到位后的调度帧里挂上 —— 等行出现,不数帧(#6346)。
    await until('tool rows mount', () => host.querySelector('[data-slot="tool-run"], [data-slot="tool-call-trigger"]') != null);
    const group = host.querySelector<HTMLElement>('[data-slot="tool-run"][data-expanded="false"] [data-collapse-id]');
    if (group) group.click();
    await until('subagent row mounts collapsed', () => trigger()?.getAttribute('aria-expanded'), (v) => v === 'false');
    expect(trigger().getAttribute('role')).toBe('button');
    trigger().click();
    await until('subagent row expands', () => trigger().getAttribute('aria-expanded') === 'true');
    expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('FULL_PROMPT_DETAIL');
    expect(host.textContent).toContain(withChild ? 'FAILURE_DETAIL' : 'SUCCESS_DETAIL');
    // The transcript intentionally keeps child activity in the agent panel.
    if (withChild) expect(JSON.stringify(parser.history)).toContain('CHILD_RESULT');
    const panel = host.querySelector<HTMLElement>('[data-slot="tool-call-request"]')!;
    expect(panel.getBoundingClientRect().height).toBeGreaterThan(0);
    const parent = panel.parentElement!;
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(parent.getBoundingClientRect().bottom + 1);
    trigger().click();
    // 收起时行在高度 tween 里保持展开态,tween 结束 aria 才翻 —— 等它。
    await until('subagent row collapses', () => trigger().getAttribute('aria-expanded') === 'false');
    expect(host.querySelector('[data-slot="tool-call-request"]')).toBeNull();
    view.dispose();
    view = createChatView({ context: ctx, state, parent: host });
    await until('remounted view mounts the subagent row', () => trigger() != null);
    trigger().click();
    await until('subagent row expands after remount', () => trigger().getAttribute('aria-expanded') === 'true');
    expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('FULL_PROMPT_DETAIL');
  } finally {
    view.dispose(); state.dispose(); ctx.dispose(); host.remove();
  }
});

it.each([false, true])('#6020 nested subagent group measures the shared payload and children (expanded: %s)', async (expanded) => {
  const node: ItemNode = {
    item: { kind: 'subagent', id: 'parent', name: 'Inspect files', status: 'done', phase: 'completed',
      request: 'FULL_ARGUMENT', result: 'DIRECT_RESULT' },
    children: [{ item: { kind: 'tool', id: 'child', name: 'child lookup', status: 'done' }, children: [] }],
  };
  const ctx = makeContractCtx({ width: 420, isCollapsed: (id) => id === 'parent' && expanded });
  try {
    const reading = await renderAndMeasureUnit(toolGroupUnitDef, node, ctx, (element) => {
      expect(element.textContent?.includes('FULL_ARGUMENT')).toBe(expanded);
      expect(element.textContent?.includes('DIRECT_RESULT')).toBe(expanded);
      expect(element.textContent?.includes('child lookup')).toBe(expanded);
      return {};
    });
    expect(reading.dom).toBe(reading.computed);
  } finally { ctx.caches.clearAll(); }
});
