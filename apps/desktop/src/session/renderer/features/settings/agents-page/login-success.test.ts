import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import { describe, expect, it } from 'vitest';
import { acpLoginAttemptSucceeded, acpLoginView, cancelsLoginOnClose, rereadOnReturn } from './login-success';

describe('cancelsLoginOnClose(#6264 登录窗口关掉时那次登录怎么办)', () => {
  it('别的机器上的登录:窗口一没(任何路径)就取消 —— 没人再盯着那台机器上的登录命令', () => {
    expect(cancelsLoginOnClose({ remote: true })).toBe(true);
  });

  it('本机:照 #4900 不取消(设备码要人离开窗口去浏览器授权)', () => {
    expect(cancelsLoginOnClose({ remote: false })).toBe(false);
  });
});

const login = (patch: Partial<NonNullable<AuthStatusModelState['login']>> = {}) => ({
  methodId: 'google',
  startedAt: 1,
  transport: 'acp-authenticate' as const,
  pendingUrl: null,
  exit: null,
  outcome: null,
  ...patch,
});

describe('协议登录弹窗(acp-authenticate,#6335)', () => {
  it('还没有这一趟 ⇒ starting;在等浏览器 ⇒ waiting,备用链接取厂商打出来的那条', () => {
    expect(acpLoginView({ status: { kind: 'unauthenticated' }, login: null })).toEqual({
      phase: 'starting',
      fallbackUrl: null,
    });
    expect(
      acpLoginView({
        status: { kind: 'unauthenticated' },
        login: login({ pendingUrl: { id: 'u', url: 'https://accounts.google.com/x' } }),
      })
    ).toEqual({ phase: 'waiting', fallbackUrl: 'https://accounts.google.com/x' });
  });

  it('失败结局 ⇒ failed,带厂商原话', () => {
    expect(
      acpLoginView({
        status: { kind: 'unauthenticated' },
        login: login({ outcome: { kind: 'failed', message: 'authenticate: boom' } }),
      })
    ).toEqual({ phase: 'failed', message: 'authenticate: boom', fallbackUrl: null });
  });

  it('本来就已登录的人「重新登录」时,等浏览器期间不许自己关窗 —— 这一趟收尾(login 清空)才算', () => {
    const progress = { sawInitialReading: true };
    expect(
      acpLoginAttemptSucceeded({ status: { kind: 'authenticated' }, login: login() }, progress)
    ).toBe(false);
    expect(acpLoginAttemptSucceeded({ status: { kind: 'authenticated' }, login: null }, progress)).toBe(true);
    expect(
      acpLoginAttemptSucceeded({ status: { kind: 'authenticated' }, login: null }, { sawInitialReading: false })
    ).toBe(false);
  });
});

describe('rereadOnReturn(终端登录:回到窗口时再问一次,#6335)', () => {
  it('从没登上 / 判不出开始 ⇒ 回来就重读;从已登录开始(换账号)⇒ 不读,免得旧凭据把弹窗提前关掉', () => {
    expect(rereadOnReturn({ status: { kind: 'unauthenticated' }, login: null })).toBe(true);
    expect(rereadOnReturn({ status: { kind: 'unknown' }, login: null })).toBe(true);
    expect(rereadOnReturn({ status: { kind: 'authenticated' }, login: null })).toBe(false);
  });
});
