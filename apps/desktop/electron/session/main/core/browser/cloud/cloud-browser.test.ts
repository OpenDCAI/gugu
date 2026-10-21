import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gugu-cloud-browser-test' }, safeStorage: {} }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CloudBrowser, STOPPED_MESSAGE, TAKEN_OVER_MESSAGE, secretVariants } from './cloud-browser';

/** #7199 云浏览器的闸:接管独占、agent 正在做一步时接管要排队、停止 / 继续、请人接手。不碰 Chrome。 */
function browser() {
  return new CloudBrowser({ PATH: '' }, '/tmp/gugu-cloud-browser-test');
}

describe('#7199 cloud browser gates', () => {
  it('人接管 = agent 的浏览器动作被拒,原话交回;交还后照常', () => {
    const b = browser();
    expect(b.acquireControl('viewer-1')).toBe('granted');
    expect(b.toolStarting('s1')).toEqual({ ok: false, message: TAKEN_OVER_MESSAGE });
    // 第二个看的人申请:被别处控制着
    expect(b.acquireControl('viewer-2')).toBe('occupied');
    expect(b.controlFor('viewer-2')).toBe('occupied');
    b.releaseControl('viewer-1');
    expect(b.toolStarting('s1')).toEqual({ ok: true });
  });

  it('agent 正在做一步时人申请接管:先排着(等 Agent 完成当前操作),这一步做完就给;排着时 agent 不再开新的一步', () => {
    const b = browser();
    expect(b.toolStarting('s1')).toEqual({ ok: true });
    expect(b.acquireControl('viewer-1')).toBe('pending');
    expect(b.controlFor('viewer-1')).toBe('pending');
    expect(b.toolStarting('s2').ok).toBe(false);
    b.toolFinished('s1');
    expect(b.controlFor('viewer-1')).toBe('granted');
  });

  it('看的人断开 / 取消申请 = 交还', () => {
    const b = browser();
    b.toolStarting('s1');
    b.acquireControl('viewer-1');
    b.releaseControl('viewer-1');
    b.toolFinished('s1');
    expect(b.controlFor('viewer-1')).toBe('released');
    expect(b.toolStarting('s1').ok).toBe(true);
  });

  it('停止任务 = 之后的动作一律拒,直到「允许 Agent 继续」', () => {
    const b = browser();
    b.stopAutomation();
    expect(b.status(null).automation).toBe('stopped');
    expect(b.toolStarting('s1')).toEqual({ ok: false, message: STOPPED_MESSAGE });
    b.resumeAutomation();
    expect(b.toolStarting('s1')).toEqual({ ok: true });
    expect(b.status(null).automation).toBe('running');
  });

  it('请人接手:没开过页签先说清楚;停止时照实收场', async () => {
    const b = browser();
    const none = await b.requestTakeover('s1', { reason: '输验证码' });
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/browser_navigate/);
  });

  it('请人登录:还没打开登录页 = 先去打开', async () => {
    const result = await browser().requestLogin('s1', {});
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/login page/) });
  });

  it('没有 Chrome = 状态里说不可用', () => {
    expect(browser().status(null)).toMatchObject({ available: false, running: false, tabs: [], live: null });
  });

  it('密码的几种写法都盖住;太短的不收(否则把结果里同样的字全盖掉)', () => {
    expect(secretVariants('a"b\\c d')).toEqual(['a"b\\c d', 'a\\"b\\\\c d', 'a%22b%5Cc%20d', 'a%22b%5Cc+d']);
    // 表单用 GET 提交时的写法:!'()*~ 也编码(encodeURIComponent 不编)
    expect(secretVariants("Passw0rd!~")).toContain('Passw0rd%21%7E');
    expect(secretVariants('abc')).toEqual([]);
    const b = browser();
    expect(b.redact('nothing to hide')).toBe('nothing to hide');
    // 一个密码是另一个的一段:长的先盖,❌ 露出尾巴
    (b as unknown as { secrets: Set<string> }).secrets.add('pass1');
    (b as unknown as { secrets: Set<string> }).secrets.add('pass1-longer');
    expect(b.redact('x pass1-longer y')).toBe('x •••••• y');
  });

  it('停止之后浏览器没了:下一次是新的一次,不再停着(否则卡片收起后没人能放行)', () => {
    const b = browser();
    b.stopAutomation();
    expect(b.status(null).automation).toBe('stopped');
    (b as unknown as { ended: (reason: string) => void }).ended('chrome exited');
    expect(b.status(null).automation).toBe('idle');
  });
});
