// @vitest-environment jsdom
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatView, TranscriptTurn } from '@gugu/session-chat-ui';
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import { createNode, createReactHarness, waitForCondition } from '../../../support/testHarness';
import { askReveal } from '../../../../apps/desktop/src/hooks/useSourceMessageReveal';
import { publishSelfIdentity } from '../../../../apps/desktop/src/lib/selfIdentityBridge';

const calls = vi.hoisted(() => ({ history: vi.fn(), scroll: vi.fn(), toast: vi.fn(), restore: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessions: { getStoredHistory: calls.history } }) }));
vi.mock('@renderer/features/sessions/restore-session-flow', () => ({ restoreArchivedSession: calls.restore }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: calls.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/components/assistant-ui/session-transcript-view.aui', async () => {
  const { createElement, useEffect, useRef } = await import('react');
  return { SessionTranscriptView: (props: { turns: TranscriptTurn[]; onReady: (handle: ChatView) => void; commands: { flashMessageId: string | null } }) => {
    const ready = useRef(props.onReady);
    useEffect(() => { ready.current({ scrollToItem: calls.scroll } as unknown as ChatView); }, []);
    return createElement('section', { 'data-testid': 'transcript', 'data-flash': props.commands.flashMessageId },
      props.turns.flatMap(turn => turn.items).filter(item => item.kind === 'message').map(item => item.text).join('\n'));
  } };
});
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { SessionHistoryModal } from '@renderer/features/sessions/history/session-history-modal';
import { TabContent } from '@renderer/features/sessions/history/session-history-tab-view';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turn = (seq: number, text: string): TranscriptTurn => ({ id: `${sessionId}:turn:s${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `${sessionId}:turn:s${seq}:message:m`, seq: 0, role: 'assistant', text }] });
let harness: ReturnType<typeof createReactHarness>;
let client: QueryClient;
let frames: FrameRequestCallback[];
beforeEach(() => {
  harness = createReactHarness(); client = new QueryClient(); frames = [];
  calls.history.mockReset().mockImplementation(async ({ before }: { before?: number }) => before === undefined
    ? { turns: [turn(9, 'Newer')], nextCursor: 5 } : { turns: [turn(0, 'Original')], nextCursor: null });
  calls.scroll.mockReset(); calls.toast.mockReset(); calls.restore.mockReset();
  publishSelfIdentity({ userId: 'owner', displayName: null, guguNumber: null });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
});
afterEach(() => { harness.cleanup(); client.clear(); publishSelfIdentity(null); vi.unstubAllGlobals(); });

it.each(['dialog', 'tab'])('pages, centers and flashes the exact stored hit in the %s host', async host => {
  const target = turn(0, '').items[0].id;
  askReveal(`task:${sessionId}`, messageQuoteLink({ kind: 'session', sessionId, itemId: target }));
  const view = host === 'dialog'
    ? createNode(Dialog, { open: true }, createNode(DialogContent, {}, createNode(SessionHistoryModal,
      { projectId: 'project', sessionId, title: 'Archived task', onClose: vi.fn(), onSuccess: vi.fn() })))
    : createNode('div', {}, createNode('div', { 'data-testid': 'terminal' }, 'Terminal'), createNode(TabContent,
      { host: { resolvedTabs: [{ isActive: true, kind: 'session-history', resource: { sessionId } }] } }));
  await harness.render(createNode(QueryClientProvider, { client }, view));
  await waitForCondition(() => calls.history.mock.calls.some(([request]) => request.before === 5), 'stored older page requested');
  while (!calls.scroll.mock.calls.length) {
    await waitForCondition(() => frames.length > 0 || calls.scroll.mock.calls.length > 0, 'stored transcript layout');
    await act(async () => { for (const callback of frames.splice(0)) callback(0); });
  }
  expect(calls.scroll).toHaveBeenCalledWith(target, { align: 'center' });
  await vi.waitFor(() => expect(document.querySelector('[data-testid="transcript"]')?.getAttribute('data-flash')).toBe(target));
  expect(calls.history.mock.calls.map(([request]) => request)).toEqual([{ sessionId, before: undefined }, { sessionId, before: 5 }]);
  expect(calls.toast).not.toHaveBeenCalled();
  expect(calls.restore).not.toHaveBeenCalled();
  if (host === 'tab') expect(harness.container.querySelector('[data-testid="terminal"]')?.textContent).toBe('Terminal');
});
