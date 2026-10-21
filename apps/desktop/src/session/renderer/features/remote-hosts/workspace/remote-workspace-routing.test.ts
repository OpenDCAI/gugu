import { describe, expect, it } from 'vitest';
import type { Translate } from '../connection-status';
import {
  forwardedUrl,
  presentForwardedUrl,
  remoteLoopbackPort,
  remoteToolReach,
  remoteWorkspaceFailure,
  remoteWorkspaceTools,
} from './remote-workspace-routing';

const t: Translate = (key, values) => (values ? `${key}${JSON.stringify(values)}` : key);

describe('会话右侧工作区的各格问哪台机器(#6264)', () => {
  it('远程 SSH:审阅、终端、浏览器、端口、文件都给,顺序与本机清单一致(去掉侧边聊天;端口照 VS Code 挨着浏览器)', () => {
    expect(remoteWorkspaceTools({ directTerminal: true })).toEqual(['review', 'terminal', 'browser', 'ports', 'files']);
  });

  it('远程隧道:只有审阅与文件 —— 终端、浏览器、端口不在清单里,❌ 灰着摆一格说我们做不到', () => {
    expect(remoteWorkspaceTools({ directTerminal: false })).toEqual(['review', 'files']);
  });

  it('机器已经不在账号里(读不到设备):按隧道处理,不给直连的两格', () => {
    expect(remoteWorkspaceTools(null)).toEqual(['review', 'files']);
  });

  it('离线的机器:格子照样在,只说「离线 · 上次在线 X」;在线就放行', () => {
    const now = Date.parse('2026-09-24T10:00:00Z');
    expect(remoteToolReach({ isOnline: true, lastSeenAt: null, label: 'd22' }, now, t)).toEqual({ ok: true });
    expect(remoteToolReach({ isOnline: false, lastSeenAt: '2026-09-24T09:55:00Z', label: 'd22' }, now, t)).toEqual({
      ok: false,
      label: 'remoteHost.condition.offline{"device":"d22","ago":"remoteHost.agoMinutes{\\"count\\":5}"}',
    });
    expect(remoteToolReach({ isOnline: false, lastSeenAt: null, label: 'd22' }, now, t)).toEqual({
      ok: false,
      label: 'remoteHost.condition.offlineNever{"device":"d22"}',
    });
    expect(remoteToolReach(null, now, t)).toEqual({ ok: false, label: 'remoteWorkspace.machineGone' });
  });

  it('失败时说人话:老 server、会话没了、找不到、没权限、没应答各一句;原因码 ❌ 进句子', () => {
    const err = (code: string) => Object.assign(new Error('raw'), { code });
    expect(remoteWorkspaceFailure(err('unknown_method'), 'd22', t)).toBe('remoteWorkspace.serverTooOld{"device":"d22"}');
    expect(remoteWorkspaceFailure(err('session_not_found'), 'd22', t)).toBe('remoteHost.condition.sessionGone{"device":"d22"}');
    expect(remoteWorkspaceFailure(err('not_found'), 'd22', t)).toBe('task.fileNotFound');
    expect(remoteWorkspaceFailure(err('permission_denied'), 'd22', t)).toBe('remoteWorkspace.permissionDenied{"device":"d22"}');
    expect(remoteWorkspaceFailure(err('outside_workspace'), 'd22', t)).toBe('remoteWorkspace.outsideWorkspace');
    // 超时是传输层失败,没有业务码。
    expect(remoteWorkspaceFailure(new Error('Device RPC timed out'), 'd22', t)).toBe('remoteWorkspace.noAnswer{"device":"d22"}');
    expect(remoteWorkspaceFailure(err('internal_error'), 'd22', t)).toBe('remoteWorkspace.failed{"device":"d22"}');
  });
});

describe('浏览器:哪些网址指的是那台机器自己', () => {
  it('localhost / 127.0.0.1 / 0.0.0.0 / [::1] 的端口 = 那台机器上的端口;没写端口取协议默认', () => {
    expect(remoteLoopbackPort('http://localhost:3000/app?x=1')).toBe(3000);
    expect(remoteLoopbackPort('http://127.0.0.1:5173')).toBe(5173);
    expect(remoteLoopbackPort('http://0.0.0.0:8080/')).toBe(8080);
    expect(remoteLoopbackPort('http://[::1]:9000/')).toBe(9000);
    expect(remoteLoopbackPort('http://localhost/')).toBe(80);
    expect(remoteLoopbackPort('https://localhost/')).toBe(443);
  });

  it('普通网址、非 http 协议、写坏的地址:不转发,照常在这台电脑上开', () => {
    expect(remoteLoopbackPort('https://example.com:3000/')).toBeNull();
    expect(remoteLoopbackPort('about:blank')).toBeNull();
    expect(remoteLoopbackPort('file:///tmp/x.html')).toBeNull();
    expect(remoteLoopbackPort('not a url')).toBeNull();
  });

  it('转好之后加载本机端口;路径、查询串、锚点原样保留', () => {
    // 一律 127.0.0.1:ssh 只绑在它上面;写 localhost 会被解析到 ::1,落到这台电脑上只听 IPv6 的别的服务(2026-09-24 实撞)。
    expect(forwardedUrl('http://127.0.0.1:3000/a/b?q=1#h', 3000)).toBe('http://127.0.0.1:3000/a/b?q=1#h');
    expect(forwardedUrl('http://localhost:3000/', 50123)).toBe('http://127.0.0.1:50123/');
    expect(forwardedUrl('http://[::1]:3000/', 3000)).toBe('http://127.0.0.1:3000/');
  });

  it('地址栏把实际加载的 127.0.0.1:<本机端口> 显示回那台机器上的 localhost:<端口>', () => {
    const map = (local: number) => (local === 50123 ? 3000 : local === 8765 ? 8765 : null);
    expect(presentForwardedUrl('http://127.0.0.1:50123/a?q=1', map)).toBe('http://localhost:3000/a?q=1');
    expect(presentForwardedUrl('http://127.0.0.1:8765/', map)).toBe('http://localhost:8765/');
    expect(presentForwardedUrl('http://127.0.0.1:9999/', map)).toBeNull();
    expect(presentForwardedUrl('https://example.com/', map)).toBeNull();
  });
});
