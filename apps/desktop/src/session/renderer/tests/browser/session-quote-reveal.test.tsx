import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createChatView, createChatContext, createChatState, buildChatTheme, DEFAULT_CONFIG, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../features/sessions/acp/acp-chat-store';
import { useSessionSourceMessage } from '../../features/sessions/acp/use-session-source-message';
import { until } from '../../../../../../../tests/support/awaitCondition';

const turn = (id: string, seq: number): TranscriptTurn => ({ id: `turn-${seq}`, seq, initiator: 'user', items: [{ kind: 'message', id, role: 'user', seq: 0, text: 'Repeated words' }] });

describe('session quote navigation', () => {
  it('loads preceding pages once, jumps to the exact source, and flashes that row', async () => {
    const state = { committedTurns: [turn('latest', 3)], activeTurnSnapshot: null };
    const pages = [[turn('middle', 2)], [turn('source', 1)]];
    const loadOlderHistory = vi.fn(async () => pages.shift() ?? []);
    const store = { sessionId: 'task-a', chatState: { transcript: { state } }, get canLoadOlderHistory() { return pages.length > 0; }, loadOlderHistory } as unknown as AcpChatStore;
    const scrollToItem = vi.fn();
    const loadOlder = vi.fn((older: TranscriptTurn[]) => { state.committedTurns = [...older, ...state.committedTurns]; });
    const view = { scrollToItem, loadOlder } as unknown as ChatView;
    const missing = vi.fn();
    let actions!: ReturnType<typeof useSessionSourceMessage>;
    function Harness() {
      actions = useSessionSourceMessage(store, useRef(view), missing);
      return <button onClick={() => actions.reveal('gugu-session://task-a?message=source')}>Quote</button>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      root.render(<Harness />);
      await until('quote button is mounted', () => !!host.querySelector('button'));
      host.querySelector('button')!.click();
      await until('loaded source receives the flash', () => actions.flashMessageId === 'source');
      expect(loadOlderHistory).toHaveBeenCalledTimes(2);
      expect(loadOlder).toHaveBeenCalledTimes(2);
      expect(scrollToItem).toHaveBeenLastCalledWith('source', { align: 'center' });
      expect(actions.flashMessageId).toBe('source');
      expect(missing).not.toHaveBeenCalled();
      actions.reveal('latest');
      await until('already-loaded source receives the flash', () => actions.flashMessageId === 'latest');
      expect(loadOlderHistory).toHaveBeenCalledTimes(2);
      expect(scrollToItem).toHaveBeenLastCalledWith('latest', { align: 'center' });
      actions.reveal('deleted');
      await until('missing source is reported', () => missing.mock.calls.length === 1);
      expect(missing).toHaveBeenCalledOnce();
      expect(scrollToItem).toHaveBeenCalledTimes(2);
    } finally {
      root.unmount();
      host.remove();
    }
  });
  it('rejects another task before reading history, even when an item id matches', async () => {
    const state = { committedTurns: [turn('source', 1)], activeTurnSnapshot: null };
    const loadOlderHistory = vi.fn(async () => []);
    const store = { sessionId: 'task-a', chatState: { transcript: { state } }, canLoadOlderHistory: true, loadOlderHistory } as unknown as AcpChatStore;
    const scrollToItem = vi.fn(), missing = vi.fn();
    const view = { scrollToItem } as unknown as ChatView;
    function Harness() {
      const actions = useSessionSourceMessage(store, useRef(view), missing);
      return <button onClick={() => actions.reveal('gugu-session://task-b?message=source')}>Quote</button>;
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      root.render(<Harness />);
      await until('foreign quote button is mounted', () => !!host.querySelector('button'));
      host.querySelector('button')!.click();
      expect(missing).toHaveBeenCalledOnce();
      expect(loadOlderHistory).not.toHaveBeenCalled();
      expect(scrollToItem).not.toHaveBeenCalled();
    } finally { root.unmount(); host.remove(); }
  });
  it('centers a source after real history rows have been prepended and laid out', async () => {
    const context = createChatContext({ locale: () => 'en-US', theme: buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true }) });
    const state = createChatState(context);
    state.transcript.history.seed([turn('latest', 20)]);
    const pages = [[turn('middle', 19)], Array.from({ length: 12 }, (_, i) => ({ ...turn(i === 8 ? 'source' : `older-${i}`, i), items: [...turn(i === 8 ? 'source' : `older-${i}`, i).items, { kind: 'message' as const, id: `answer-${i}`, seq: 1, role: 'assistant' as const, text: 'An earlier response' }] }))];
    const store = { chatState: state, get canLoadOlderHistory() { return pages.length > 0; },
      loadOlderHistory: async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return pages.shift() ?? []; } } as unknown as AcpChatStore;
    let actions!: ReturnType<typeof useSessionSourceMessage>;
    function Harness() {
      const parent = useRef<HTMLDivElement>(null), view = useRef<ChatView | null>(null);
      actions = useSessionSourceMessage(store, view, vi.fn());
      useEffect(() => {
        view.current = createChatView({ context, state, parent: parent.current!, stickToBottom: false });
        return () => view.current?.dispose();
      }, []);
      return <><button onClick={() => actions.reveal('source')}>Quote</button><div ref={parent} style={{ width: 600, height: 300 }} /></>;
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      root.render(<Harness />);
      await until('real chat view is mounted', () => !!host.querySelector('[data-chat-scroll]'));
      host.querySelector('button')!.click();
      await until('source has been revealed', () => actions.flashMessageId === 'source');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
      const row = host.querySelector<HTMLElement>('[data-item-id="source"]')!;
      expect(row).not.toBeNull();
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().top);
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroll.getBoundingClientRect().bottom);
    } finally { root.unmount(); host.remove(); }
  });
  it('shares a pending top-edge page and leaves a disposed view untouched', async () => {
    let finish!: (turns: TranscriptTurn[]) => void;
    const pending = new Promise<TranscriptTurn[]>(resolve => { finish = resolve; });
    const loadOlderHistory = vi.fn(() => pending);
    const store = { chatState: { transcript: { state: { committedTurns: [turn('latest', 3)], activeTurnSnapshot: null } } }, canLoadOlderHistory: true, loadOlderHistory } as unknown as AcpChatStore;
    const scrollToItem = vi.fn(), loadOlder = vi.fn(), missing = vi.fn();
    const view = { scrollToItem, loadOlder } as unknown as ChatView;
    let actions!: ReturnType<typeof useSessionSourceMessage>;
    function Harness() {
      actions = useSessionSourceMessage(store, useRef(view), missing);
      return <button onClick={() => actions.reveal('source')}>Quote</button>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      root.render(<Harness />);
      await until('pending quote button is mounted', () => !!host.querySelector('button'));
      host.querySelector('button')!.click();
      const shared = actions.loadOlder();
      expect(loadOlderHistory).toHaveBeenCalledOnce();
      root.unmount();
      finish([turn('source', 1)]);
      await shared;
      expect(loadOlder).not.toHaveBeenCalled();
      expect(scrollToItem).not.toHaveBeenCalled();
      expect(missing).not.toHaveBeenCalled();
    } finally { host.remove(); }
  });
});
