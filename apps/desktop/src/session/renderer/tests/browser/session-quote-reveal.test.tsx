import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ChatView, TranscriptTurn } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../features/sessions/acp/acp-chat-store';
import { useSessionSourceMessage } from '../../features/sessions/acp/use-session-source-message';
import { until } from '../../../../../../../tests/support/awaitCondition';

const turn = (id: string, seq: number): TranscriptTurn => ({ id: `turn-${seq}`, seq, initiator: 'user', items: [{ kind: 'message', id, role: 'user', seq: 0, text: 'Repeated words' }] });

describe('session quote navigation', () => {
  it('loads preceding pages once, jumps to the exact source, and flashes that row', async () => {
    const state = { committedTurns: [turn('latest', 3)], activeTurnSnapshot: null };
    const pages = [[turn('middle', 2)], [turn('source', 1)]];
    const loadOlderHistory = vi.fn(async () => pages.shift() ?? []);
    const store = { chatState: { transcript: { state } }, get canLoadOlderHistory() { return pages.length > 0; }, loadOlderHistory } as unknown as AcpChatStore;
    const scrollToItem = vi.fn();
    const loadOlder = vi.fn((older: TranscriptTurn[]) => { state.committedTurns = [...older, ...state.committedTurns]; });
    const view = { scrollToItem, loadOlder } as unknown as ChatView;
    const missing = vi.fn();
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
      await until(() => !!host.querySelector('button'));
      host.querySelector('button')!.click();
      await until(() => actions.flashMessageId === 'source');
      expect(loadOlderHistory).toHaveBeenCalledTimes(2);
      expect(loadOlder).toHaveBeenCalledTimes(2);
      expect(scrollToItem).toHaveBeenLastCalledWith('source', { align: 'center' });
      expect(actions.flashMessageId).toBe('source');
      expect(missing).not.toHaveBeenCalled();
      actions.reveal('latest');
      await until(() => actions.flashMessageId === 'latest');
      expect(loadOlderHistory).toHaveBeenCalledTimes(2);
      expect(scrollToItem).toHaveBeenLastCalledWith('latest', { align: 'center' });
      actions.reveal('deleted');
      await until(() => missing.mock.calls.length === 1);
      expect(missing).toHaveBeenCalledOnce();
      expect(scrollToItem).toHaveBeenCalledTimes(2);
    } finally {
      root.unmount();
      host.remove();
    }
  });
});
