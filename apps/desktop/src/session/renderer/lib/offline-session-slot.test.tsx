// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Device } from '@gugu/core/shared/types/chat';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { DevicesContext, useDevicesStore } from '@/store/devicesContext';
import { ChatStoreProvider, useChatStore } from '@/store/chatContext';
import { readShellSlots } from '@/lib/shellSlots';
import { updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory';

vi.mock('@/mobile/agent-watch/SessionTimelinePage', () => ({ SessionTimelinePage: () => {
  const { drafts } = useChatStore('drafts');
  return <output data-shared-timeline="">{drafts['session:host/task']}</output>;
} }));
import { OfflineSessionSlotHost } from '@/components/chat/OfflineSessionSlotHost';
import { OfflineSessionSlot } from './offline-session-slot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const nodes: HTMLElement[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  nodes.splice(0).forEach(node => node.remove());
  removeDeviceSessions('host');
});
function root() {
  const node = document.body.appendChild(document.createElement('div'));
  nodes.push(node);
  const root = createRoot(node);
  roots.push(root);
  return { node, root };
}
function Shell() {
  const devices = useDevicesStore();
  const chat = useChatStore();
  const device = { device_id: 'host', label: 'Host', is_online: true, capabilities: {} } as Device;
  return <DevicesContext.Provider value={{ ...devices, devices: [device] }}>
    <ChatStoreProvider value={{ ...chat, drafts: { 'session:host/task': 'kept by the account' } }}>
      <OfflineSessionSlotHost />
    </ChatStoreProvider>
  </DevicesContext.Provider>;
}
it('portals the shared page with account context, with separate slots for the same task and exact cleanup', async () => {
  const shell = root();
  const embedded = root();
  const session = { conversationId: 'task', runtime: 'acp', nativeInputVersion: 2 } as SessionpageSessionSummary;
  updateDeviceSessions('host', { sessions: [session], projects: [], cached: false, loading: false, error: null });
  await act(async () => {
    shell.root.render(<Shell />);
    embedded.root.render(<><OfflineSessionSlot key="one" sessionId="task" /><OfflineSessionSlot key="two" sessionId="task" /></>);
  });
  const pages = [...embedded.node.querySelectorAll('[data-shared-timeline]')];
  expect(pages.map(page => page.textContent)).toEqual(['kept by the account', 'kept by the account']);
  await act(async () => embedded.root.render(<OfflineSessionSlot key="two" sessionId="task" />));
  expect(embedded.node.querySelectorAll('[data-shared-timeline]')).toHaveLength(1);
  expect(embedded.node.querySelector('[data-shared-timeline]')).toBe(pages[1]);
  await act(async () => embedded.root.render(null));
  expect([...readShellSlots()!.getSlots().keys()].filter(key => key.startsWith('session-offline:'))).toEqual([]);
});
