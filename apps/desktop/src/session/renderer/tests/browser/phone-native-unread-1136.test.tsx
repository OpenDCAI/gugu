import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { useNativeConversationVisibility } from '@/lib/nativeConversationVisibility';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

const markSessionSeen = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  machineRpc: vi.fn(() => ({ sessions: { markSessionSeen } })), fetchBackgroundTasks: vi.fn(async () => []),
}));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); markSessionSeen.mockClear(); });

it('a shown phone task clears the host read bit once, and only while it is unread', async () => {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
  const conversation = (unseen: boolean) => <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="host" sessionId="session" agentName="Agent" unseen={unseen}
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />;
  await renderWithAppProviders(harness, conversation(false), { contacts: {} });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(markSessionSeen).not.toHaveBeenCalled();
  harness.cleanup();
  harness = createReactHarness();
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, conversation(true), { contacts: {} });
  await until('the shown unread task is marked read', () => markSessionSeen.mock.calls.length > 0);
  expect(markSessionSeen.mock.calls).toEqual([['session']]);
});

it('reports the real phone transcript tail to the shared DM read host as well as history pagination', async () => {
  await page.viewport(390, 844);
  const timeline = emptyAgentWatchTimeline();
  // A native transcript tail can have no IM aliases for the older unread DM rows.
  timeline.turns = [{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Continue the task' },
    { kind: 'message', id: 'latest', seq: 1, role: 'assistant', text: 'Latest task reply' },
  ] }];
  let entries: ReturnType<typeof useNativeConversationVisibility> = new Map();
  function VisibilityProbe() { entries = useNativeConversationVisibility(); return null; }
  const tail = vi.fn();
  harness = createReactHarness();
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <><VisibilityProbe /><SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} onAtBottom={tail} /></>, { contacts: {} });
  await until('the phone reports its real tail to its host pagination callback', () => tail.mock.calls.length > 0);
  await until('the phone publishes readable task rows', () => [...entries.values()].some(entry => entry.visible.includes('latest')));
  expect([...entries.values()]).toEqual([expect.objectContaining({ sessionId: 'session', atTail: true })]);
});
