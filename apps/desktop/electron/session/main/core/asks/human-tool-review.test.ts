import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', send: vi.fn(async (_input: unknown) => ({ status: 'queued' })) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, powerMonitor: { getSystemIdleTime: () => 999 } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/core/extensions/extension-bridge-relay', () => ({ requestExtensionInstallConsent: vi.fn(), closeExtensionInstallConsent: vi.fn() }));
vi.mock('@gugu/core/local/state/paths', () => ({ resolveGuguHome: () => fixture.root }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { reportHostWait: vi.fn(), on: vi.fn() } }));
vi.mock('../sessions/agent-question-store', () => ({ readAgentQuestionRecords: () => [], rememberAgentQuestion: vi.fn(), settleAgentQuestionRecord: vi.fn() }));
vi.mock('../session-timeline/service', () => ({ readSessionRow: () => ({ projectId: 'project' }), syncAsked: vi.fn() }));
vi.mock('../sessions/sendMessage', () => ({ sendMessage: fixture.send }));
vi.mock('../../../../mcp/gugu-im-server.mjs', () => ({ extensionAttachmentOf: async () => ({ message_id: '0c000000-0000-4000-8000-0000000010a2' }) }));

import { ask, hostAsks, resetAsks } from './ask';
import { humanToolPending, restoreHumanToolResults, runHumanTool, yieldHumanToolWaits } from './human-tool-wait';
import { readHumanToolRecords } from './human-tool-results';
import { CloudBrowser } from '../browser/cloud/cloud-browser';
import { runAppAction } from '../../../../mcp/app-tool-host';
import { syncAsked } from '../session-timeline/service';

const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function result(input: unknown) {
  return JSON.parse((input as { text: string }).text.match(/<gugu_human_tool_result>\n(.*?)\n<\/gugu_human_tool_result>/s)![1]!);
}

describe('human-tool review regressions', () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'human-tool-review-'));
    fixture.send.mockReset().mockResolvedValue({ status: 'queued' });
    vi.useFakeTimers();
  });
  afterEach(async () => { resetAsks(); await drain(); vi.useRealTimers(); rmSync(fixture.root, { recursive: true, force: true }); });

  it('does not apply an earlier completed operation steer to a later tool', async () => {
    yieldHumanToolWaits('session');
    const tool = runHumanTool<unknown>('session', 'app_install', undefined, signal => ask('session', {
      itemId: 'new-operation', kind: 'permission', title: 'Install', options: [], origin: { source: 'app-install' },
    }, { signal }), humanToolPending);
    const returned = vi.fn(); void tool.then(returned); await drain();
    expect(returned).not.toHaveBeenCalled();
    hostAsks.get('session')!.get('new-operation')!.answered({ optionId: 'install', by: 'desktop' });
    await expect(tool).resolves.toMatchObject({ optionId: 'install' });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('lets an immediate answer win even when admission preceded initial card publication', async () => {
    vi.mocked(syncAsked).mockImplementationOnce(() => {
      hostAsks.get('session')!.get('immediate')!.answered({ optionId: 'install', by: 'desktop' });
    });
    const tool = runHumanTool<unknown>('session', 'app_install', undefined, signal => {
      yieldHumanToolWaits('session');
      return ask('session', { itemId: 'immediate', kind: 'permission', title: 'Install', options: [], origin: { source: 'app-install' } }, { signal });
    }, humanToolPending);
    await expect(tool).resolves.toMatchObject({ optionId: 'install' }); await drain();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each(['same session', 'another session'])('a replacement request from %s is never a human refusal', async lane => {
    const browser = new CloudBrowser({ PATH: '' }, fixture.root);
    const next = lane === 'same session' ? 'session' : 'other';
    const tabs = (browser as unknown as { sessionTab: Map<string, string> }).sessionTab;
    tabs.set('session', 'tab'); tabs.set(next, 'tab');
    const first = browser.requestTakeover('session', {});
    const id = [...hostAsks.get('session')!.keys()][0]!;
    yieldHumanToolWaits('session'); await first;
    const second = browser.requestTakeover(next, {});
    await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    const ended = result(fixture.send.mock.calls[0]![0]);
    expect(ended.request_id).toBe(id);
    expect(ended.result.message).toMatch(/withdrawn/i);
    expect(ended.result.message).not.toMatch(/declined|person closed/i);
    [...hostAsks.get(next)!.values()][0]!.answered({ optionId: 'cancel', by: 'desktop' });
    await expect(second).resolves.toMatchObject({ ok: false, message: expect.stringContaining('declined') });
  });

  it('remembers admission during cross-device preparation and releases the later consent wait', async () => {
    let continueDevices!: () => void;
    const devices = new Promise<void>(resolve => { continueDevices = resolve; });
    let preparing = false;
    const tool = runAppAction({ action: 'install', device: 'other', source_message_id: 'msg:0c000000-0000-4000-8000-0000000010a2' },
      { kind: 'social', grantKey: 'taskpage:session' } as never,
      async () => {
        const answer = await ask('session', { itemId: 'late-consent', kind: 'permission', title: 'Install', options: [], origin: { source: 'app-install' } }, {});
        return { outcome: typeof answer === 'string' ? answer : 'confirmed', digest: 'bytes' };
      }, async action => {
        const request = action as { action: string; consent?: { kind: string } };
        if (request.action === 'devices') { preparing = true; await devices; return [{ device_id: 'other', label: 'Other' }]; }
        return request.consent?.kind === 'return' ? { outcome: 'ask', asks: true, ask: { manifestDigest: 'bytes' } } : { installed: true };
      });
    const returned = vi.fn(); void tool.then(returned);
    await vi.waitFor(() => expect(preparing).toBe(true));
    yieldHumanToolWaits('session'); continueDevices();
    await vi.waitFor(() => expect(hostAsks.get('session')?.has('late-consent')).toBe(true));
    await drain();
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending', request_id: 'late-consent' }));
    expect(fixture.send).not.toHaveBeenCalled();
    hostAsks.get('session')!.get('late-consent')!.answered({ optionId: 'install', by: 'desktop' });
    await drain();
    expect(result(fixture.send.mock.calls[0]![0]).result.installed).toBe(true);
  });

  it.each(['tool name', 'typed IDs', 'pictures'])('late app_manage preserves %s through durable delivery', async aspect => {
    fixture.send.mockRejectedValueOnce(new Error('retry the durable result'));
    const bytes = Buffer.alloc(32_000, 173);
    const picture = { label: 'Installation preview', mimeType: 'image/png', data: bytes.toString('base64') };
    const tool = runAppAction({ action: 'manage', url: 'gugu://app/sample?device=local&variant=mine', operation: 'switch' },
      { kind: 'social', grantKey: 'taskpage:session' } as never, async () => {
        await ask('session', { itemId: 'manage-consent', kind: 'permission', title: 'Switch App', options: [], origin: { source: 'app-install' } }, {});
        return { device_id: 'd0000000-0000-4000-8000-000000000001', nested: { message_id: 'a0000000-0000-4000-8000-000000000002' }, pictures: [picture] };
      }, async () => [{ device_id: 'local', this_machine: true }]);
    await vi.waitFor(() => expect(hostAsks.get('session')?.size).toBe(1));
    yieldHumanToolWaits('session'); await tool;
    hostAsks.get('session')!.get('manage-consent')!.answered({ optionId: 'install', by: 'desktop' }); await drain();
    const sent = fixture.send.mock.calls[0]![0] as { text: string };
    const actual = result(sent);
    const record = readHumanToolRecords('session')[0]!;
    if (aspect === 'tool name') expect(actual.tool).toBe('app_manage');
    else if (aspect === 'typed IDs') expect(actual.result).toMatchObject({
      device_id: 'device:d0000000-0000-4000-8000-000000000001', nested: { message_id: 'msg:a0000000-0000-4000-8000-000000000002' },
    });
    else {
      expect(sent.text.includes(picture.data)).toBe(false);
      expect(JSON.stringify(record).includes(picture.data)).toBe(false);
      expect(actual.pictures).toHaveLength(1);
      expect(actual.pictures[0]).toMatchObject({ label: picture.label, mime_type: 'image/png' });
      expect(readFileSync(actual.pictures[0].file_path)).toEqual(bytes);
    }
    const messageId = record.messageId;
    restoreHumanToolResults('session', 'project'); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.send.mock.calls[1]![0]).toEqual(expect.objectContaining({ clientMessageId: messageId, text: sent.text }));
  });

  it.each(['invalid picture', 'image write failure'])('delivers the actual result without pictures after %s', async failure => {
    const pictures = failure === 'invalid picture' ? [{ label: 'bad' }]
      : [{ label: 'preview', mimeType: 'image/png', data: 'AAAA' }];
    const tool = runHumanTool<unknown>('session', 'app_install', undefined, async signal => {
      await ask('session', { itemId: 'picture-failure', kind: 'permission', title: 'Install', options: [], origin: { source: 'app-install' } }, { signal });
      return { installed: true, device_id: 'd0000000-0000-4000-8000-000000000001', pictures };
    }, humanToolPending);
    yieldHumanToolWaits('session'); await tool;
    if (failure === 'image write failure') writeFileSync(join(fixture.root, 'human-tool-results', 'session'), 'not a directory');
    hostAsks.get('session')!.get('picture-failure')!.answered({ optionId: 'install', by: 'desktop' }); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    const actual = result(fixture.send.mock.calls[0]![0]);
    expect(actual.result).toEqual({ installed: true, device_id: 'device:d0000000-0000-4000-8000-000000000001' });
    expect(actual.pictures).toBeUndefined();
    expect(actual.pictures_error).toEqual(expect.any(String));
    expect(actual.pictures_error.length).toBeGreaterThan(0);
    expect(readHumanToolRecords('session')).toEqual([]);
  });
});
