import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { page } from 'vitest/browser';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { platform } from '@/platform';
import { notify } from '@/lib/notices';
import { createReactHarness, renderWithAppProviders, deferred } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/lib/notices', async original => ({ ...(await original<object>()), notify: vi.fn(() => 0) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})),
}));

// #940's four assertions follow the phone's current host after AgentThread was retired.
// The Markdown AST excludes the closing fence's delimiter newline from code.value.
const CODE = 'const message = "中文剪贴板";\nconsole.log(message);';
const TEXT = `\`\`\`javascript\n${CODE}\n\`\`\``;
let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); vi.restoreAllMocks(); vi.mocked(notify).mockClear(); });

async function mountCopy() {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  const timeline = emptyAgentWatchTimeline();
  timeline.turns = [{ id: 'turn:s1', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'prompt', seq: 0, role: 'user', text: 'reply with code' },
    { kind: 'message', id: 'code', seq: 1, role: 'assistant', text: TEXT },
  ] }];
  await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="device" sessionId="copy-task" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
  const copySelector = '[data-user-message-actions="code"] button[aria-label="Copy"]';
  await until('conversation reply exposes its message copy action', () => !!harness.container.querySelector(copySelector));
  return harness.container.querySelector<HTMLButtonElement>(copySelector)!;
}

it('copies the complete multiline Chinese reply through the host while the WebView refuses writes', async () => {
  const browser = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('WebView clipboard denied'));
  const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue();
  const button = await mountCopy();
  button.click();
  await until('reply copied feedback follows host success', () => button.getAttribute('aria-label') === 'Copied');
  expect(write).toHaveBeenCalledExactlyOnceWith(TEXT);
  expect(browser).not.toHaveBeenCalled();
});

it('offers a separate code-block action that copies raw code', async () => {
  const browser = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('WebView clipboard denied'));
  const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue();
  await mountCopy();
  await until('code copy action mounts', () => !!harness.container.querySelector('button[aria-label="Copy code"]'));
  harness.container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
  await until('raw code is copied', () => write.mock.calls.length > 0);
  expect(write).toHaveBeenCalledExactlyOnceWith(CODE);
  expect(browser).not.toHaveBeenCalled();
});

it('waits for the native write before showing copied feedback', async () => {
  const browser = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('WebView clipboard denied'));
  const pending = deferred<void>();
  const write = vi.spyOn(platform, 'writeClipboardText').mockReturnValue(pending.promise);
  const button = await mountCopy();
  button.click();
  expect(write).toHaveBeenCalledExactlyOnceWith(TEXT);
  expect(button.getAttribute('aria-label')).not.toContain('Copied');
  await act(async () => pending.resolve());
  await until('copy success is shown', () => button.getAttribute('aria-label') === 'Copied');
  expect(browser).not.toHaveBeenCalled();
});

it('reports a native refusal without copied feedback or browser fallback', async () => {
  const browser = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('WebView clipboard denied'));
  const error = new Error('Native clipboard refused');
  const write = vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(error);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const button = await mountCopy();
  button.click();
  await until('copy failure reaches the host error outlet', () => vi.mocked(notify).mock.calls.some(([notice]) => notice.tier === 'error'));
  expect(write).toHaveBeenCalledExactlyOnceWith(TEXT);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: expect.stringContaining(error.message) }));
  expect(button.getAttribute('aria-label')).not.toContain('Copied');
  expect(browser).not.toHaveBeenCalled();
});
