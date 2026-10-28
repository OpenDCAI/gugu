import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gugu-cloud-browser-test' }, safeStorage: {} }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: vi.fn(), reportHostWait: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/session-timeline/service', () => ({ readSessionRow: () => ({ id: 'row' }), syncAsked: () => undefined }));

import { CloudBrowser, NO_PERSON_VIEW_MESSAGE, NO_PERSON_VIEW_TELL_PERSON, cloudAgentBrowserBridge, setCloudBrowserForTests } from './cloud-browser';
import { hostAsks } from '../../asks/ask';

/**
 * #737 removed the only place the person could see the server's browser. Until the Browser Use App's tab shows it,
 * asking the person to log in or take over must not open an Ask (it would only offer Done / Cancel, and Done would
 * tell the agent it is logged in): the agent is told plainly, and no Ask is left behind.
 */
describe('server browser without a person view', () => {
  afterEach(() => { setCloudBrowserForTests(null); hostAsks.clear(); });

  function bridgeWithTab() {
    const browser = new CloudBrowser({ PATH: '' }, '/tmp/gugu-cloud-browser-test');
    (browser as unknown as { sessionTab: Map<string, string> }).sessionTab.set('task-1', 'tab-1');
    setCloudBrowserForTests(browser);
    return cloudAgentBrowserBridge();
  }

  const browserAsks = () => [...hostAsks.values()].flatMap((asks) => [...asks.values()])
    .filter((entry) => entry.request.origin.source === 'browser-assistance');

  it('a login request is refused at once, without an Ask', async () => {
    const bridge = bridgeWithTab();
    await expect(bridge.requestLogin!('task-1', { reason: 'Log in to example.com' })).resolves.toEqual({ ok: false, message: NO_PERSON_VIEW_MESSAGE });
    expect(browserAsks()).toEqual([]);
  });

  it('a takeover request is refused at once, without an Ask', async () => {
    const bridge = bridgeWithTab();
    await expect(bridge.requestTakeover!('task-1', { reason: 'Enter the SMS code' })).resolves.toEqual({ ok: false, message: NO_PERSON_VIEW_MESSAGE });
    expect(browserAsks()).toEqual([]);
  });

  it('the agent gets a sentence it can pass on to the person as is, not just an error', async () => {
    const told = await bridgeWithTab().requestLogin!('task-1', {});
    expect(NO_PERSON_VIEW_TELL_PERSON).toBe('这台服务器上暂时不能请你登录或接手浏览器，需要登录的活可以交给本机上的 agent。');
    expect(told.message).toContain(`「${NO_PERSON_VIEW_TELL_PERSON}」`);
    expect(told.message).toMatch(/no request was opened/);
    expect(told.message).toMatch(/Do not ask for passwords or codes in chat/);
  });
});
