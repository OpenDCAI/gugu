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

const { retry } = vi.hoisted(() => ({ retry: vi.fn(async () => {}) }));
vi.mock('@/lib/sessionInputOutboxBridge', async original => ({ ...(await original<object>()), retrySessionInputs: retry }));
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})) }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  Object.assign(state(), { accountId: null, rows: EMPTY, valid: () => false });
  retry.mockClear();
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
