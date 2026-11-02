import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { getI18n } from 'react-i18next';
import { SessionpageRpcError } from '@/mobile/agent-watch/sessionpage-rpc';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { textFilePatch } from '@gugu/session-core/lib';
import { createReactHarness, renderWithAppProviders, clickElement } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

const read = vi.hoisted(() => vi.fn());
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()),
  fetchSessionOptions: vi.fn(() => new Promise(() => {})), setSessionOption: vi.fn(),
  machineRpc: vi.fn(() => ({})), fetchToolImage: vi.fn(), stopBackgroundTask: vi.fn(),
  fetchBackgroundTasks: vi.fn(async () => []), readOpenedFileChunk: read,
}));
let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

it.each([true, false])('routes a file card through the existing host permission check after history reload (opened output: %s)', async opened => {
  await page.viewport(390, 844);
  const sessionId = 'phone-edit-885', path = '/workspace/report.md', itemId = `${sessionId}:turn:s4:tool:edit`;
  const contents = 'CURRENT-DISK-CONTENT-885';
  read.mockReset().mockImplementation(async () => {
    if (!opened) throw new SessionpageRpcError('not_opened', 'This task has not opened that output');
    return { size: contents.length, etag: 'current', data: btoa(contents) };
  });
  for (let load = 0; load < 2; load++) {
    const timeline = emptyAgentWatchTimeline();
    timeline.turns = [{ id: `${sessionId}:turn:s4`, seq: 4, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'owner', seq: 0, role: 'user', text: 'Edit report.md' },
      { kind: 'patch-tool-call', id: itemId, seq: 1, toolCallId: 'edit', title: 'Edit files', status: 'done', contentBlocks: [textFilePatch(path, 'before', 'after')] },
      { kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'File updated.' },
    ] }];
    harness = createReactHarness();
    harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
    await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host-device" sessionId={sessionId} agentName="Codex" nativeRecord
      sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
      onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
    const file = () => harness.container.querySelector<HTMLButtonElement>('[data-slot="file-change-summary"] button[title]');
    await until('the phone renders the completed edit card', () => !!file());
    expect(file()!.disabled).toBe(false);
    await clickElement(file()!);
    if (opened) {
      await until('the existing phone preview displays host-authorized bytes', () => document.body.textContent?.includes(contents) === true);
    } else {
      const refusal = String(getI18n().t('agentWatch.output.readFailed', { ns: 'main' }));
      await until('the existing preview displays the host refusal', () => document.body.textContent?.includes(refusal) === true);
      expect(document.body.textContent).not.toContain(contents);
    }
    expect(read).toHaveBeenLastCalledWith('host-device', expect.objectContaining({ conversationId: sessionId, path, offset: 0 }));
    expect(read.mock.lastCall?.[1]).not.toHaveProperty('itemId');
    harness.cleanup();
  }
  expect(read).toHaveBeenCalledTimes(2);
});
