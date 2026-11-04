import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { getI18n } from 'react-i18next';
import { getLocaleSnapshot, setLocalePreference } from '@/i18n';
import { formatBytes } from '@renderer/utils/formatBytes';
import { OPENED_FILE_MAX_BYTES } from '@gugu/session-core/session-record/contract';
import { SessionpageRpcError } from '@/mobile/agent-watch/sessionpage-rpc';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { textFilePatch } from '@gugu/session-core/lib';
import { createReactHarness, renderWithAppProviders, clickElement } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMainCatalog';
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
const initialLocale = getLocaleSnapshot().preference;
afterEach(() => { harness?.cleanup(); setLocalePreference(initialLocale); });

const scenarios = [
  { name: 'opened output', error: null, key: null },
  { name: 'not_opened', error: new SessionpageRpcError('not_opened', 'This task has not opened that output'), key: 'notOpened' },
  { name: 'file_missing', error: new SessionpageRpcError('file_missing', 'File missing'), key: 'fileMissing' },
  { name: 'too_large', error: new SessionpageRpcError('too_large', 'File too large'), key: 'tooLarge' },
  { name: 'read_failed', error: new SessionpageRpcError('read_failed', 'Host read failed'), key: 'readFailed' },
  { name: 'network error', error: new Error('Network disconnected'), key: 'readFailed' },
];
const entries = ['edit card', 'prose link'] as const;
it.each(scenarios.flatMap(scenario => (['zh-CN', 'en-US'] as const).flatMap(locale => entries.map(entry => ({ ...scenario, locale, entry })))))(
  '$locale: shows the correct $entry result after history reload ($name)', async ({ error, key, locale, entry }) => {
  setLocalePreference(locale);
  await page.viewport(390, 844);
  const sessionId = 'phone-edit-885', path = '/workspace/report.md', itemId = `${sessionId}:turn:s4:tool:edit`;
  const contents = 'CURRENT-DISK-CONTENT-885';
  read.mockReset().mockImplementation(async () => {
    if (error) throw error;
    return { size: contents.length, etag: 'current', data: btoa(contents) };
  });
  for (let load = 0; load < 2; load++) {
    const timeline = emptyAgentWatchTimeline();
    timeline.turns = [{ id: `${sessionId}:turn:s4`, seq: 4, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'owner', seq: 0, role: 'user', text: 'Edit report.md' },
      { kind: 'patch-tool-call', id: itemId, seq: 1, toolCallId: 'edit', title: 'Edit files', status: 'done', contentBlocks: [textFilePatch(path, 'before', 'after')] },
      { kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'File updated. [report.md](/workspace/report.md)' },
    ] }];
    harness = createReactHarness();
    harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
    await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host-device" sessionId={sessionId} agentName="Codex" nativeRecord
      sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
      onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
    const file = () => harness.container.querySelector<HTMLElement>(entry === 'edit card'
      ? '[data-slot="file-change-summary"] button[title]' : 'a[href="/workspace/report.md"]');
    await until('the phone renders the file entry', () => !!file());
    expect(file()!.hasAttribute('disabled')).toBe(false);
    await clickElement(file()!);
    if (!error) {
      await until('the existing phone preview displays host-authorized bytes', () => document.body.textContent?.includes(contents) === true);
    } else {
      const editedNotOpened = locale === 'zh-CN' ? 'agent 改过 · 请在电脑上打开' : 'Edited by agent · Open on computer';
      const notOpened = entry === 'edit card' ? editedNotOpened : locale === 'zh-CN'
        ? '这条会话还没打开过这个文件。' : "This session hasn't opened this file yet.";
      const refusal = key === 'notOpened' ? notOpened : String(getI18n().t(`agentWatch.output.${key}`, {
        ns: 'main', limit: formatBytes(OPENED_FILE_MAX_BYTES),
      }));
      await until('the preview has finished reading the host refusal', () => !!document.querySelector('[data-file-selection]') && !document.querySelector('[data-testid="message-file-preview-loading"]'));
      expect(document.body.textContent).toContain(refusal);
      if (key !== 'notOpened') expect(document.body.textContent).not.toContain(notOpened);
      else expect(document.body.textContent).not.toContain(String(getI18n().t('agentWatch.output.readFailed', { ns: 'main' })));
      if (key !== 'notOpened' || entry === 'prose link') expect(document.body.textContent).not.toContain(editedNotOpened);
      expect(document.body.textContent).not.toContain(contents);
    }
    expect(read).toHaveBeenLastCalledWith('host-device', expect.objectContaining({ conversationId: sessionId, path, offset: 0 }));
    expect(read.mock.lastCall?.[1]).not.toHaveProperty('itemId');
    harness.cleanup();
  }
  expect(read).toHaveBeenCalledTimes(2);
});
