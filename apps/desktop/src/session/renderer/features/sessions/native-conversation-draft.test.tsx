// @vitest-environment jsdom
import { act, useCallback, useState, type ReactNode, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ChatStoreProvider, useChatStore } from '@/store/chatContext';
import { readNativeOfflineDraft, writeNativeOfflineDraft } from '@/lib/nativeOfflineDraft';
import { useSessionConversationDraft } from '@/mobile/agent-watch/use-session-conversation-draft';

const scope = vi.hoisted(() => ({ account: 'owner' as string | null, initial: {} as Record<string, string> }));
vi.mock('@/lib/sessionInputOutboxBridge', () => ({
  state: () => ({ accountId: scope.account, valid: () => scope.account !== null }),
  useSessionInputAccount: () => scope.account,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let draft: ReturnType<typeof useSessionConversationDraft>;
let persisted: Record<string, string>;
let root: Root;
let node: HTMLElement;
function Account({ children }: { children: ReactNode }) {
  const defaults = useChatStore();
  const [drafts, setDrafts] = useState(scope.initial);
  persisted = drafts;
  const setDraft = useCallback((key: string, update: SetStateAction<string>) => setDrafts(previous => ({
    ...previous, [key]: typeof update === 'function' ? update(previous[key] ?? '') : update,
  })), []);
  return <ChatStoreProvider value={{ ...defaults, drafts, setDraft }}>{children}</ChatStoreProvider>;
}
function Composer({ native = true, session = 'task' }: { native?: boolean; session?: string }) {
  draft = useSessionConversationDraft('host', session, native);
  return <output>{draft.text}</output>;
}
const render = (child: ReactNode) => act(() => root.render(<Account>{child}</Account>));
beforeEach(() => {
  scope.account = 'owner'; scope.initial = {}; localStorage.clear();
  node = document.body.appendChild(document.createElement('div')); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); });
it('retains edits for ACP and does not resurrect consumed text on the next offline visit', () => {
  writeNativeOfflineDraft('host', 'task', 'offline half');
  render(<Composer />);
  expect(node.textContent).toBe('offline half');
  act(() => draft.setText(text => `${text} + App handoff`));
  render(null);
  expect(readNativeOfflineDraft('host', 'task')).toBe('offline half + App handoff');
  render(<Composer />);
  expect(node.textContent).toBe('offline half + App handoff');
  render(null);
  // ACP uses these existing read/clear operations when the live composer returns.
  const restored = readNativeOfflineDraft('host', 'task');
  writeNativeOfflineDraft('host', 'task', '');
  expect(restored).toBe('offline half + App handoff');
  render(<Composer />);
  expect(node.textContent).toBe('');
});
it('consumes an existing desktop timeline draft once into the ACP handoff store', () => {
  scope.initial = { 'session:host/task': 'older timeline draft' };
  writeNativeOfflineDraft('host', 'task', 'offline draft');
  render(<Composer />);
  expect(node.textContent).toBe('offline draft\nolder timeline draft');
  expect(persisted['session:host/task']).toBe('');
  render(null); render(<Composer />);
  expect(node.textContent).toBe('offline draft\nolder timeline draft');
  render(null);
  writeNativeOfflineDraft('host', 'task', '');
  render(<Composer />);
  expect(node.textContent).toBe('');
});
it('isolates tasks and accounts and clears durable text on send', () => {
  render(<Composer />);
  act(() => draft.setText('first'));
  render(<Composer session="second" />);
  expect(node.textContent).toBe('');
  act(() => draft.setText('second'));
  expect(readNativeOfflineDraft('host', 'task')).toBe('first');
  scope.account = 'peer';
  render(<Composer session="second" />);
  expect(node.textContent).toBe('');
  act(() => draft.setText('peer'));
  act(() => { draft.setText(''); draft.flush(); });
  expect(readNativeOfflineDraft('host', 'second')).toBe('');
  scope.account = 'owner';
  render(<Composer session="second" />);
  expect(node.textContent).toBe('second');
});
it('keeps the existing phone draft writer and flush unchanged', () => {
  scope.initial = { 'session:host/task': 'phone draft' };
  writeNativeOfflineDraft('host', 'task', 'desktop only');
  render(<Composer native={false} />);
  expect(node.textContent).toBe('phone draft');
  act(() => { draft.setText('phone edit'); draft.flush(); });
  expect(persisted['session:host/task']).toBe('phone edit');
  expect(readNativeOfflineDraft('host', 'task')).toBe('desktop only');
});

it('keeps keystrokes typed before the session input account is ready', () => {
  scope.account = null;
  render(<Composer />);
  act(() => draft.setText('early'));
  act(() => draft.setText(text => `${text}!`));
  expect(node.textContent).toBe('early!');
  scope.account = 'owner';
  render(<Composer />);
  expect(node.textContent).toBe('early!');
  expect(readNativeOfflineDraft('host', 'task')).toBe('early!');
  expect(persisted['session:host/task']).toBe('');
  render(null); render(<Composer />);
  expect(node.textContent).toBe('early!');
});

it('hands text entered between accounts only to the account that becomes ready', () => {
  render(<Composer />);
  act(() => draft.setText('owner draft'));
  scope.account = null;
  render(<Composer />);
  expect(node.textContent).toBe('');
  act(() => draft.setText('between accounts'));
  expect(node.textContent).toBe('between accounts');
  scope.account = 'peer';
  render(<Composer />);
  expect(node.textContent).toBe('between accounts');
  expect(readNativeOfflineDraft('host', 'task')).toBe('between accounts');
  expect(persisted['session:host/task']).toBe('');
  scope.account = 'owner';
  render(<Composer />);
  expect(node.textContent).toBe('owner draft');
  expect(readNativeOfflineDraft('host', 'task')).toBe('owner draft');
  scope.account = 'peer';
  render(<Composer />);
  expect(node.textContent).toBe('between accounts');
  expect(readNativeOfflineDraft('host', 'task')).toBe('between accounts');
});


it.each(['Hi', 'Hi again', 'Hi appended', ''])('settles the native slot across mounts without consuming a changed draft (%j)', text => {
  render(<Composer />);
  act(() => draft.setText('Hi'));
  const submitted = draft;
  render(null);
  render(<Composer />);
  act(() => draft.setText(text));
  act(() => submitted.committed('Hi'));
  expect(node.textContent).toBe(text === 'Hi' ? '' : text);
  expect(readNativeOfflineDraft('host', 'task')).toBe(text === 'Hi' ? '' : text);
  render(null); render(<Composer />);
  expect(node.textContent).toBe(text === 'Hi' ? '' : text);
});

it('does not let an accepted old task clear the newly opened task', () => {
  render(<Composer />);
  act(() => draft.setText('Hi'));
  const submitted = draft;
  render(<Composer session="second" />);
  act(() => draft.setText('Hi'));
  act(() => submitted.committed('Hi'));
  expect(node.textContent).toBe('Hi');
  expect(readNativeOfflineDraft('host', 'task')).toBe('');
  expect(readNativeOfflineDraft('host', 'second')).toBe('Hi');
});

it('ignores an old account commit after the active account changes', () => {
  render(<Composer />);
  act(() => draft.setText('Hi'));
  const submitted = draft;
  scope.account = 'peer';
  render(<Composer />);
  act(() => draft.setText('Hi'));
  act(() => submitted.committed('Hi'));
  expect(node.textContent).toBe('Hi');
  expect(readNativeOfflineDraft('host', 'task')).toBe('Hi');
  scope.account = 'owner';
  expect(readNativeOfflineDraft('host', 'task')).toBe('Hi');
});
