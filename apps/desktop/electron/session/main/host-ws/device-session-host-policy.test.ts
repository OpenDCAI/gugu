// 别的电脑连进来时不给的调用:属于「看界面的那台电脑」的动作,在这台机器上执行就是错的。
import { describe, expect, it } from 'vitest';
import { remoteInvokePolicy } from './device-session-host';

describe('remote invoke policy', () => {
  it('refuses the on-screen report from another desktop: it would overwrite what this machine shows', () => {
    expect(remoteInvokePolicy('sessions.reportSessionsOnScreen')).toBe(false);
    expect(remoteInvokePolicy('sessions.getSessions')).toBe(true);
  });
});
