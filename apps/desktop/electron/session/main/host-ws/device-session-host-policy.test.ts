// 别的电脑连进来时不给的调用:属于「看界面的那台电脑」的动作,在这台机器上执行就是错的。
import { describe, expect, it } from 'vitest';
import { remoteInvokePolicy, remoteInvokePolicyForCaller } from './device-session-host';

describe('remote invoke policy', () => {
  it('lets the phone read the host Terminal setting through the existing settings route', () => {
    expect(remoteInvokePolicy('appSettings.get', ['terminal'])).toBe(true);
  });
  it('refuses the on-screen report from another desktop: it would overwrite what this machine shows', () => {
    expect(remoteInvokePolicy('sessions.reportSessionsOnScreen')).toBe(false);
    expect(remoteInvokePolicy('sessions.getSessions')).toBe(true);
  });
  it('#609 answers where its task workspace lives: another desktop opens a no-folder task there', () => {
    expect(remoteInvokePolicy('app.getSessionHomeDir')).toBe(true);
    expect(remoteInvokePolicy('app.openExternal')).toBe(false);
  });
  it('allows only the two recovery operations with a caller-bound owner; clear is an explicit write grant', () => {
    const policy = remoteInvokePolicyForCaller('owner');
    for (const name of ['assistant_work_list', 'assistant_work_clear']) {
      expect(policy('app.assistantAppCall', ['callProgram', { name, arguments: {}, server: 'resources' }, 'owner'])).toBe(true);
      expect(policy('app.assistantAppCall', ['callProgram', { name }, 'other'])).toBe(false);
      expect(remoteInvokePolicyForCaller(undefined)('app.assistantAppCall', ['callProgram', { name }, 'owner'])).toBe(false);
    }
    for (const name of ['library_write', 'arbitrary', 'assistant_work_clear_extra'])
      expect(policy('app.assistantAppCall', ['callProgram', { name }, 'owner'])).toBe(false);
    expect(policy('app.assistantAppCall', ['messageAgent', {}, 'owner'])).toBe(false);
    expect(policy('app.assistantAppCall', ['callProgram', { name: 'assistant_work_clear', arguments: { owner: 'other' } }, 'owner'])).toBe(false);
    expect(remoteInvokePolicy('app.assistantAppCall')).toBe(false);
    expect(policy('app.closeWindow')).toBe(false);
  });
});
