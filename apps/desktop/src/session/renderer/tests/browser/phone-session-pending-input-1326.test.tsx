import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { page } from 'vitest/browser';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import type { LifeView } from '@shared/core/sessions/session-life';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const { retry } = vi.hoisted(() => ({ retry: vi.fn(async () => {}) }));
const hostLife = vi.hoisted(() => ({ view: null as LifeView | null }));
const hostHistory = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: hostLife.view, error: null }) }));
vi.mock('@/lib/sessionInputOutboxBridge', async original => ({ ...(await original<object>()), retrySessionInputs: retry }));
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})), machineRpc: () => ({ sessions: { getStoredHistory: hostHistory.read } }) }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  Object.assign(state(), { accountId: null, rows: EMPTY, valid: () => false });
  retry.mockClear();
  hostLife.view = null;
  hostHistory.read.mockReset();
});

it('keeps an unknown incoming receipt on its native bubble on the phone', async () => {
  await page.viewport(390, 844);
  const text = renderDeliveryEnvelope({ route: 'session-direct', from: 'Remote sender', fromType: 'agent', fromId: 'session:sender', messageId: 'msg:incoming', at: 'now', content: 'Incoming phone instruction' });
  hostLife.view = { sessionId: 'phone-task', version: 1, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null,
    pending: { count: 1, items: [{ seq: 1, messageId: 'incoming', kind: 'session-direct', text, preview: text, state: 'unknown', failure: null }] } };
  const timeline = emptyAgentWatchTimeline();
  timeline.turns = [{ id: 'native', seq: 0, initiator: 'agent', items: [{ kind: 'message', id: 'native-echo', seq: 0, role: 'user', text }], outcome: { kind: 'done' } }];
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="device" sessionId="phone-task" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
  await until('unknown receipt decorates the native bubble', () => !!harness.container.querySelector('[data-send-state="unknown"]'));
  expect(harness.container.querySelectorAll('[data-user-card]')).toHaveLength(1);
  expect(harness.container.querySelector('[data-user-card="native-echo"]')).not.toBeNull();
  expect(harness.container.textContent).toContain('Remote sender');
  expect(harness.container.querySelector('[data-send-state="unknown"] button')).toBeNull();
});

it('uses the ordinary pending projection on the phone, keeping acceptance and retry in the same bubble', async () => {
  await page.viewport(390, 844);
  const input = { id: 'phone-send', sessionId: 'phone-task', accountId: 'owner', deviceId: 'device', text: 'hello from phone', createdAt: Date.now(), queued: false };
  Object.assign(state(), { accountId: 'owner', rows: [input], valid: () => true });
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="phone-task" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
  await until('phone pending input appears in the transcript', () => !!harness.container.querySelector('[data-user-card="phone-send"]') && !!harness.container.querySelector('[data-send-state="sending"]'));
  const top = harness.container.querySelector('[data-user-card]')!.getBoundingClientRect().top;
  await act(async () => { state().rows = []; changed(); });
  await until('acknowledgement removes only its spinner', () => !harness.container.querySelector('[data-send-state="sending"]'));
  expect(harness.container.querySelectorAll('[data-user-card]')).toHaveLength(1);
  expect(harness.container.querySelector('[data-user-card]')!.getBoundingClientRect().top).toBe(top);
  await act(async () => { state().rows = [{ ...input, failure: { code: 'send-failed', message: 'connection refused' } }]; changed(); });
  await until('phone failure exposes in-place retry', () => !!harness.container.querySelector('[data-send-state="failed"] button'));
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-send-state="failed"] button')!.click(); });
  expect(retry).toHaveBeenCalledOnce();
  expect(harness.container.querySelectorAll('[data-user-card]')).toHaveLength(1);
});


it('loads older phone history before placing an unknown receipt and never draws it at the tail first', async () => {
  await page.viewport(390, 844);
  const text = renderDeliveryEnvelope({ route: 'session-direct', from: 'Remote sender', fromType: 'agent', fromId: 'session:sender', messageId: 'msg:older-incoming', at: 'now', content: 'Older incoming instruction' });
  hostLife.view = { sessionId: 'phone-task', version: 1, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null,
    pending: { count: 1, items: [{ seq: 1, messageId: 'older-incoming', kind: 'session-direct', text, preview: text, state: 'unknown', failure: null }] } };
  const timeline = emptyAgentWatchTimeline();
  timeline.hasOlder = true;
  timeline.turns = [{ id: 'latest', seq: 2, initiator: 'user', items: [{ kind: 'message', id: 'latest-user', seq: 0, role: 'user', text: 'Latest human input' }], outcome: { kind: 'done' } }];
  let release: (value: { turns: typeof timeline.turns; nextCursor: number | null }) => void = () => {};
  hostHistory.read.mockImplementation(() => new Promise(resolve => { release = resolve }));
  const loadOlder = vi.fn(async () => {});
  const props = { deviceId: 'device', sessionId: 'phone-task', agentName: 'Agent', nativeRecord: true, sessionRuntime: 'acp' as const,
    respondingItemId: null, onRespond: vi.fn(), onSend: vi.fn(), pendingSends: [], sending: false, agentWorking: false, onStop: vi.fn(), stopping: false, onLoadOlder: loadOlder };
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionConversation {...props} timeline={timeline} historyCursor={2} />, { contacts: {} });
  await until('missing unknown receipt requests its older page', () => hostHistory.read.mock.calls.length === 1);
  expect(harness.container.textContent).not.toContain('Older incoming instruction');
  const older = { ...timeline, hasOlder: false, turns: [{ id: 'older', seq: 1, initiator: 'agent' as const,
    items: [{ kind: 'message' as const, id: 'older-native', seq: 0, role: 'user' as const, text }], outcome: { kind: 'done' as const } }, ...timeline.turns] };
  await act(async () => { release({ turns: [older.turns[0]!], nextCursor: null }); });
  await until('older native bubble owns its unknown status', () => !!harness.container.querySelector('[data-user-card="older-native"]') && !!harness.container.querySelector('[data-send-state="unknown"]'));
  expect(harness.container.querySelectorAll('[data-user-card]')).toHaveLength(2);
  expect(harness.container.querySelector('[data-user-card="older-incoming"]')).toBeNull();
});


it('retains the phone recovery label on the same ordinary sending input', async () => {
  await page.viewport(390, 844);
  const input = { id: 'recovering-send', sessionId: 'phone-task', accountId: 'owner', deviceId: 'device', text: 'Recover and send', createdAt: Date.now(), queued: false };
  Object.assign(state(), { accountId: 'owner', rows: [input], valid: () => true });
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="phone-task" agentName="Agent" nativeRecord
    startupPrompt={{ id: input.id, text: input.text, starting: 'restoring', held: true }}
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
  await until('the sending bubble retains its restoration process', () => !!harness.container.querySelector('[data-send-state="sending"]') && /Restoring|恢复中/.test(harness.container.textContent ?? ''));
  expect(harness.container.querySelectorAll('[data-user-card]')).toHaveLength(1);
});
