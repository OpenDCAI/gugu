/** @jsxImportSource solid-js */
/**
 * Browser contract for `ChatContext.setLayout` on a mounted view (#4874).
 *
 * The preference flips at runtime from the settings page while transcripts are
 * mounted. The contract: no remount, the root re-stamps `data-chat-layout`,
 * every user row is re-measured under the new geometry (canvas height moves
 * and matches measure()), and the pill lands on the right edge behind the
 * gutter. Switching back restores the classic numbers exactly.
 */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { messageUnitDef } from '@session-chat/components/rows/message/message.def';
import { createChatCaches } from '@session-chat/core/caches';
import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const USER: ChatMessage = { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'Hello, can you help me?' };
const TURN: TranscriptTurn = {
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    USER,
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: 'Of course. What do you need?' },
  ] as TranscriptTurn['items'],
  outcome: { kind: 'done' },
};

describe('ChatContext.setLayout on a mounted ChatView', () => {
  it('re-stamps the root, re-measures the user row, and restores on the way back', async () => {
    const ctx = createChatContext();
    const state = createChatState(ctx);
    state.transcript.history.seed([TURN]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    const root = () => host.querySelector('[data-chat-root]') as HTMLElement;
    const canvas = () => host.querySelector('[data-chat-canvas]') as HTMLElement;
    const probe = () => host.querySelector('[data-chat-width-probe]') as HTMLElement;
    const card = () => host.querySelector('[data-chat-canvas] [data-user-card]') as HTMLElement;
    // The measured content includes the bubble and its message action row.
    const userContent = () => card().parentElement as HTMLElement;
    const measureUser = (editingMessage?: { itemId: string; text: string }): number => {
      const caches = createChatCaches();
      const mctx: MeasureCtx = {
        theme: ctx.theme,
        width: probe().getBoundingClientRect().width,
        isCollapsed: () => false,
        expanded: () => false,
        caches,
        expandedId: null,
        editingMessage,
      };
      const h = messageUnitDef.measure(USER, mctx, messageUnitDef.vars!);
      caches.clearAll();
      return h;
    };

    try {
      expect(root().dataset.chatLayout).toBe('single');
      const rootEl = root();
      const classicCanvasH = canvas().getBoundingClientRect().height;
      const classicCardH = card().offsetHeight;
      const classicRowH = userContent().offsetHeight;
      expect(classicRowH).toBe(measureUser());
      expect(Math.abs(card().getBoundingClientRect().width - probe().getBoundingClientRect().width)).toBeLessThan(1);

      ctx.setLayout({ preset: 'double', userGutter: 72 });
      await nextPaint();
      await nextPaint();

      // No remount: same root element, new stamp.
      expect(root()).toBe(rootEl);
      expect(root().dataset.chatLayout).toBe('double');
      // Re-measured: the user row shrank (padding 16→12, border 1→0) and the
      // rendered row agrees with measure() under the new theme.
      const baseCardH = card().offsetHeight;
      const baseRowH = userContent().offsetHeight;
      expect(baseRowH).toBe(measureUser());
      expect(baseCardH).toBeLessThan(classicCardH);
      const baseCanvasH = canvas().getBoundingClientRect().height;
      expect(baseCanvasH).toBe(classicCanvasH - (classicRowH - baseRowH));
      // Pill geometry inside the real column.
      const p = probe().getBoundingClientRect();
      const c = card().getBoundingClientRect();
      expect(Math.abs(c.right - p.right)).toBeLessThan(1);
      expect(c.left - p.left).toBeGreaterThanOrEqual(72 - 0.5);
      expect(c.width).toBeLessThan(p.width - 72);

      // Editing is a real row replacement: both the renderer and virtualizer
      // include the editor's controls, then restore exactly on cancellation.
      const edit = { itemId: USER.id, text: USER.text, pending: false, canSubmit: true,
        onChange: () => {}, onCancel: () => view.setCommands({}), onSubmit: () => {} };
      view.setCommands({ editingMessage: edit });
      await nextPaint(); await nextPaint();
      const editor = host.querySelector<HTMLElement>('[data-user-message-editor]')!;
      expect(editor).not.toBeNull();
      expect(card()).toBeNull();
      const editorH = editor.parentElement!.offsetHeight;
      expect(editorH).toBe(measureUser(edit));
      expect(canvas().getBoundingClientRect().height).toBe(baseCanvasH + editorH - baseRowH);
      const textarea = editor.querySelector('textarea')!;
      view.setCommands({ editingMessage: { ...edit, text: 'edited line\n'.repeat(20) } });
      await nextPaint(); await nextPaint();
      expect(host.querySelector('textarea')).toBe(textarea);
      expect(editor.parentElement!.offsetHeight).toBe(measureUser({ itemId: USER.id, text: 'edited line\n'.repeat(20) }));
      [...editor.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
      await nextPaint(); await nextPaint();
      expect(host.querySelector('[data-user-message-editor]')).toBeNull();
      expect(userContent().offsetHeight).toBe(baseRowH);
      expect(canvas().getBoundingClientRect().height).toBe(baseCanvasH);

      ctx.setLayout({ preset: 'single', userGutter: 0 });
      await nextPaint();
      await nextPaint();
      expect(root().dataset.chatLayout).toBe('single');
      expect(card().offsetHeight).toBe(classicCardH);
      expect(userContent().offsetHeight).toBe(classicRowH);
      expect(canvas().getBoundingClientRect().height).toBe(classicCanvasH);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });
});
