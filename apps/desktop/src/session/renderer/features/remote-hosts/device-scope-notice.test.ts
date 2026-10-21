import { describe, expect, it } from 'vitest';
import { deviceScopeNotice } from './device-scope-notice';

const translate = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as Parameters<typeof deviceScopeNotice>[1];

const NOW = Date.parse('2026-09-24T12:00:00Z');
const online = { deviceLabel: 'd22', online: true, lastSeenAt: null };
const offline = { deviceLabel: 'd22', online: false, lastSeenAt: '2026-09-24T11:00:00Z' };

function rpcError(code: string) {
  return Object.assign(new Error(code), { name: 'SessionpageRpcError', code });
}

describe('分机器的模块看别的机器时那一句话(#6264)', () => {
  it('本机:从不说话(本机自己的错误由页面原来那套处理)', () => {
    expect(deviceScopeNotice({ remote: null, error: new Error('x'), hasData: false, now: NOW }, translate)).toBeNull();
  });

  it('在线、读到了:不说话', () => {
    expect(deviceScopeNotice({ remote: online, error: null, hasData: true, now: NOW }, translate)).toBeNull();
  });

  it('离线、手上有上次的:说离线多久了,页面照旧画但只读', () => {
    const notice = deviceScopeNotice({ remote: offline, error: null, hasData: true, now: NOW }, translate);
    expect(notice).toMatchObject({ kind: 'offline', readOnly: true, retry: false });
    expect(notice?.text).toContain('deviceScope.offlineSinceCached');
    expect(notice?.text).toContain('"device":"d22"');
    expect(notice?.text).toContain('remoteHost.agoHours');
  });

  it('离线、一份都没有:说它上线后这里才有,只读', () => {
    const notice = deviceScopeNotice(
      { remote: { ...offline, lastSeenAt: null }, error: null, hasData: false, now: NOW },
      translate
    );
    expect(notice).toMatchObject({ kind: 'offline', readOnly: true });
    expect(notice?.text).toContain('deviceScope.offlineEmpty');
  });

  it('老 server 不认这个动词:说那台机器上的咕咕 server 太旧、会自己升级,❌ 报错码', () => {
    const notice = deviceScopeNotice({ remote: online, error: rpcError('unknown_method'), hasData: false, now: NOW }, translate);
    expect(notice).toMatchObject({ kind: 'server-too-old', retry: false, readOnly: true });
    expect(notice?.text).toBe('deviceScope.serverTooOld {"device":"d22"}');
    expect(notice?.text).not.toContain('unknown_method');
  });

  it('那台机器的咕咕 server 还不会一套工作台(线开不起来):同一句「太旧」,❌ 退回旧界面', () => {
    const notice = deviceScopeNotice({ remote: online, error: rpcError('server_outdated'), hasData: true, now: NOW }, translate);
    expect(notice).toMatchObject({ kind: 'server-too-old', readOnly: true });
  });

  it('问不通(超时):说此刻连不上,带「再试一次」', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'DeviceRpcTimeoutError' });
    const notice = deviceScopeNotice({ remote: online, error: timeout, hasData: false, now: NOW }, translate);
    expect(notice).toMatchObject({ kind: 'unreachable', retry: true, readOnly: false });
  });

  it('别的失败:只说没读到,原文 ❌ 进句子', () => {
    const notice = deviceScopeNotice({ remote: online, error: rpcError('agents_call_failed'), hasData: false, now: NOW }, translate);
    expect(notice).toMatchObject({ kind: 'failed', retry: true });
    expect(notice?.text).not.toContain('agents_call_failed');
  });
});
