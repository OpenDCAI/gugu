/** @jsxImportSource solid-js */
import { expect, it, vi } from 'vitest';
import { AcpTranscriptParser } from '@gugu/session-core/acp/transcript-parser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { fileOpUnitDef } from '@session-chat/components/rows/tools/file-op/file-op.def';
import { executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';
import { until } from '../../../../tests/support/awaitCondition';

const paint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it.each(['read', 'read-with-location', 'execute'] as const)('#6020 %s keeps adapter payloads through the specialized renderer', async (mode) => {
  const kind = mode === 'execute' ? 'execute' : 'read';
  const parser = new AcpTranscriptParser({ sessionId: 'specialized-details' });
  parser.push({ sessionUpdate: 'tool_call', toolCallId: 'call', title: kind === 'execute' ? 'echo command' : 'read',
    kind, status: 'completed', rawInput: { ...(kind === 'execute' ? { cwd: '/FULL_ARGUMENT' } : { path: '/FULL_ARGUMENT', offset: 42 }) },
    rawOutput: { detail: 'FULL_RESULT' },
    ...(mode === 'read-with-location' ? { locations: [{ path: '/FULL_ARGUMENT' }] } : {}),
    ...(kind === 'execute' ? { content: [{ type: 'content', content: { type: 'text', text: 'COMMAND_STDOUT' } }] } : {}) });
  const id = parser.activeTurn!.items[0].id;
  parser.endTurn();
  const ctx = createChatContext({ layout: { preset: 'single', userGutter: 0 } });
  const state = createChatState(ctx);
  state.transcript.history.seed([...parser.history]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:1200px;';
  document.body.appendChild(host);
  const openFile = vi.fn();
  const view = createChatView({ context: ctx, state, parent: host, commands: { onOpenFile: openFile } });
  const trigger = () => host.querySelector<HTMLElement>(`[data-collapse-id="${id}"]`);
  try {
    // 行由虚拟列表在 viewHeight(ResizeObserver)到位后的调度帧里挂上 —— 等行出现,不数帧(#6346)。
    await until('tool rows mount', () => host.querySelector('[data-slot="tool-run"], [data-collapse-id]') != null);
    const group = host.querySelector<HTMLElement>('[data-slot="tool-run"][data-expanded="false"] [data-collapse-id]');
    if (group) group.click();
    await until('specialized tool row mounts', () => trigger() != null);
    expect(trigger()).not.toBeNull();
    if (mode === 'read-with-location') {
      host.querySelector<HTMLButtonElement>('button[title="/FULL_ARGUMENT"]')!.click();
      // 帧界内:打开文件与(若误触发的)折叠切换都在 click() 里同步完成(FileOperation 的 on:click +
      // stopPropagation;ChatRoot 的委托同步改 viewState),这一帧只是让 DOM 走完一次绘制。
      await paint();
      expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '/FULL_ARGUMENT', itemId: id, source: 'file-op' });
      expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    }
    trigger()!.click();
    await until('specialized tool row expands', () => trigger()?.getAttribute('aria-expanded'), (v) => v === 'true');
    if (kind === 'execute') {
      // Execute already paints the command and terminal output. Its raw ACP
      // input/output envelopes are adapter bookkeeping and must not appear as
      // a second JSON section in the expanded command row.
      expect(host.querySelector('[data-slot="tool-call-request"]')).toBeNull();
      expect(host.querySelector('[data-slot="tool-call-result"]')).toBeNull();
      expect(host.textContent).toContain('COMMAND_STDOUT');
    } else {
      expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('FULL_ARGUMENT');
      expect(host.querySelector('[data-slot="tool-call-result"]')?.textContent).toContain('FULL_RESULT');
    }
    trigger()!.click();
    // 收起时行在高度 tween 里保持展开的 DOM,tween 结束才卸下载荷 —— 等它卸下。
    await until('collapse unmounts the payload', () => host.querySelector('[data-slot="tool-call-request"]') == null);
  } finally { view.dispose(); state.dispose(); ctx.dispose(); host.remove(); }
});

it.each([false, true])('#6020 specialized payload geometry matches the DOM (expanded: %s)', async (expanded) => {
  const ctx = makeContractCtx({ width: 320, isCollapsed: () => expanded });
  const payload = { request: 'FULL_ARGUMENT '.repeat(80), result: 'FULL_RESULT\n'.repeat(30) };
  try {
    const files = await renderAndMeasureUnit(fileOpUnitDef, {
      kind: 'file-op', id: 'files', op: 'read', status: 'done', ops: [{ path: '/one' }, { path: '/two' }], ...payload,
    }, ctx, (host) => {
      expect(host.textContent?.includes('FULL_ARGUMENT')).toBe(expanded);
      return {};
    });
    const command = await renderAndMeasureUnit(executeUnitDef, {
      kind: 'execute', id: 'command', command: 'echo test', outputText: 'stdout', status: 'done', startedAt: 0, ...payload,
    }, ctx, (host) => {
      // Direct ChatExecute callers may provide a deliberate result section;
      // only execute.presenter suppresses adapter rawOutput envelopes.
      expect(host.textContent?.includes('FULL_RESULT')).toBe(expanded);
      return {};
    });
    expect(files.dom).toBe(files.computed);
    expect(command.dom).toBe(command.computed);
    expect(files.spill).toBe(0);
    expect(command.spill).toBe(0);
  } finally { ctx.caches.clearAll(); }
});
