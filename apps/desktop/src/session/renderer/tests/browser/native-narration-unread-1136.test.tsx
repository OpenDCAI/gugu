import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { addNativeReplies, seeNativeReplies, unreadNativeMessages } from '@gugu/session-core/session-record/native-read';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { loadChatUi } from '@renderer/lib/chat/chat-transcript';
import { useNativeConversationRead } from '@/hooks/useNativeConversationRead';
import { updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';

const rpc = vi.hoisted(() => ({ visible: vi.fn() }));
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionVisible: rpc.visible } }) }));
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }));

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); removeDeviceSessions('host'); rpc.visible.mockReset(); });

it('acknowledges a closed visible activity through its original ids without opening its bubbles or reading a hidden page', async () => {
  const context = createChatContext({ locale: () => 'en-US',
    actor: address => address === 'user:11111111-1111-4111-8111-111111111111' ? { id: address, name: 'Peer', type: 'agent' } : null });
  const state = createChatState(context);
  const incoming = (n: number): TranscriptTurn => ({ id: `a${n}`, seq: n, initiator: 'agent', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: `incoming${n}`, seq: 0, role: 'user', text: `<gugu_delivery route="chat" from="Peer" from_id="user:11111111-1111-4111-8111-111111111111" from_type="agent" chat="group" msg="msg:${n}"><![CDATA[Agent update ${n}]]></gugu_delivery>` },
  ] });
  state.transcript.history.seed([incoming(1), incoming(2)]);
  const harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;width:390px;height:700px;display:flex';
  cleanup = () => { harness.cleanup(); state.dispose(); context.dispose(); };
  const visible = vi.fn();
  const reader = (shown: boolean) => <AgentConversationView context={context} state={state} shown={shown}
    style={{ position: 'absolute', inset: 0 }} onVisibleItems={visible} />;
  await loadChatUi();
  await harness.render(reader(false));
  await until('closed semantic header mounts', () => !!harness.container.querySelector('[data-agent-activity]'));
  expect(visible).not.toHaveBeenCalled();
  await harness.render(reader(true));
  await until('semantic row acknowledges its two original messages', () => visible.mock.calls.some(([ids]) => ids.includes('incoming1') && ids.includes('incoming2')));
  expect(harness.container.querySelector('[data-agent-conversation-message="incoming1"]')).toBeNull();
  expect(harness.container.querySelector('[data-agent-activity]')?.getAttribute('data-expanded')).toBe('false');
});
const id = (index: number) => `s:turn:s1:message:msg_reply_${index}`;
function fixture(count = 1) {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 't', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Please investigate.' },
    ...Array.from({ length: count }, (_, index) => ({ kind: 'message', id: id(index), seq: index + 1, role: 'assistant', text: `Intermediate update ${index}` })),
    { kind: 'mcp-tool-call', id: 'send', seq: count + 1, toolCallId: 'send', title: 'message_send', server: 'gugu', tool: 'message_send', status: 'done',
      rawInput: JSON.stringify({ chat_id: 'elsewhere', text: 'Investigation sent.' }), rawOutput: 'sent (id=msg:11111111-1111-4111-8111-111111111111)' },
  ] } as TranscriptTurn]);
  const harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;width:760px;height:700px;display:flex';
  cleanup = () => { harness.cleanup(); state.dispose(); context.dispose(); };
  return { context, state, harness };
}

it('acknowledges the original native reply only after identity navigation exposes its narration', async () => {
  const { context, state, harness } = fixture();
  let journal = addNativeReplies({}, [id(0)]);
  const publish = () => updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 's', nativeInputVersion: 1,
    nativeUnreadKeys: unreadNativeMessages(journal), nativeUnreadAliases: { msg_reply_0: id(0) } } as never] });
  rpc.visible.mockImplementation(async ({ itemIds }: { itemIds: string[] }) => {
    await act(async () => { journal = seeNativeReplies(journal, itemIds); publish(); });
    return { unreadKeys: unreadNativeMessages(journal) };
  });
  publish();
  function Reader({ shown }: { shown: boolean }) {
    const reading = useNativeConversationRead('host', 's', shown, () => state.transcript.state.committedTurns);
    return <AgentConversationView context={context} state={state} shown={shown} style={{ position: 'absolute', inset: 0 }} onReady={reading.onReady} onVisibleItems={reading.onVisibleItems} />;
  }
  await loadChatUi();
  await harness.render(<Reader shown={false} />);
  await until('the sent bubble exists in the hidden reader', () => !!harness.container.querySelector('[data-agent-conversation-message]'));
  expect(unreadNativeMessages(journal)).toEqual([id(0)]);
  expect(rpc.visible).not.toHaveBeenCalled();
  await harness.render(<Reader shown />);
  await until('the original narration is acknowledged', () => unreadNativeMessages(journal).length === 0);
  expect(rpc.visible).toHaveBeenCalledWith({ conversationId: 's', itemIds: [id(0)] });
});

it('does not report panel replies outside the transcript viewport until that row is scrolled into view', async () => {
  const { context, state, harness } = fixture(24);
  state.viewState.setCollapsed('t:process', true);
  const visible = new Set<string>();
  let view!: ChatView;
  const onReady = (ready: ChatView) => { view = ready; };
  const onVisibleItems = (ids: readonly string[]) => ids.forEach(id => visible.add(id));
  const reader = (shown: boolean) => <AgentConversationView context={context} state={state} shown={shown} style={{ position: 'absolute', inset: 0 }} onReady={onReady} onVisibleItems={onVisibleItems} />;
  await loadChatUi();
  // Position the retained reader before enabling acknowledgements: the initial
  // page can genuinely expose row 0 while the fixture waits for mounting.
  await harness.render(reader(false));
  await until('the retained transcript mounts', () => !!view && !!harness.container.querySelector('[data-chat-scroll]'));
  await act(async () => { view.scrollToItem(id(23), { align: 'end' }); });
  await until('the first narration is clipped and the last narration is readable', () => {
    const process = harness.container.getBoundingClientRect();
    const first = harness.container.querySelector(`[data-agent-conversation-message="${id(0)}"]`)?.getBoundingClientRect();
    const last = harness.container.querySelector(`[data-agent-conversation-message="${id(23)}"]`)?.getBoundingClientRect();
    return !!process && !!last && last.height > 0 && last.bottom <= process.bottom && last.top >= process.top
      && (!first || first.bottom <= process.top);
  });
  expect(visible.size).toBe(0);
  await harness.render(reader(true));
  await until('a visible narration confirms the observer ran', () => visible.has(id(23)));
  expect(visible.has(id(0))).toBe(false);
  await act(async () => { view.scrollToItem(id(0), { align: 'start' }); });
  await until('the targeted inner row is really readable', () => visible.has(id(0)));
});

it('does not move a retained reader to the replies that arrived while its page was hidden', async () => {
  const { context, state, harness } = fixture(3);
  let journal = addNativeReplies({}, []);
  const publish = () => updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 's', nativeInputVersion: 1,
    nativeUnreadKeys: unreadNativeMessages(journal), nativeUnreadAliases: { msg_reply_9: id(9) } } as never] });
  rpc.visible.mockImplementation(async () => ({ unreadKeys: unreadNativeMessages(journal) }));
  publish();
  let view: ChatView | undefined;
  function Reader({ shown }: { shown: boolean }) {
    const reading = useNativeConversationRead('host', 's', shown, () => state.transcript.state.committedTurns);
    return <AgentConversationView context={context} state={state} shown={shown} style={{ position: 'absolute', inset: 0 }} onVisibleItems={reading.onVisibleItems}
      onReady={(ready) => { view = ready; reading.onReady(ready); }} />;
  }
  await loadChatUi();
  await harness.render(<Reader shown />);
  await until('the reader is ready', () => !!view && !!harness.container.querySelector('[data-agent-conversation-message]'));
  const reveal = vi.spyOn(view!, 'revealItem');
  await harness.render(<Reader shown={false} />);
  // The agent keeps replying while the page is behind another rail section; nobody reads it there.
  await act(async () => {
    state.transcript.history.append([{ id: 't2', seq: 2, initiator: 'agent', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: id(9), seq: 1, role: 'assistant', text: 'Arrived while away' },
    ] } as TranscriptTurn]);
    journal = addNativeReplies(journal, [id(9)]);
    publish();
  });
  expect(unreadNativeMessages(journal), 'the reply that arrived while away was not unread, so this asserts nothing').toEqual([id(9)]);
  await harness.render(<Reader shown />);
  // Its acknowledgement runs on the same shown-page tick as the landing retry, so by then a landing would have happened.
  await until('the reply that arrived while away is read where it is', () =>
    rpc.visible.mock.calls.some(([request]) => (request as { itemIds: string[] }).itemIds.includes(id(9))));
  expect(reveal).not.toHaveBeenCalled();
});
