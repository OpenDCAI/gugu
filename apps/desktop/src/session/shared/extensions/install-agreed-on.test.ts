import { describe, expect, it, vi } from 'vitest';
import { installAgreedOn } from './install-agreed-on';

/** owner 10-16: the package agreed to in the sheet goes on another computer too — that one package, and nothing else. */
const run = (answers: unknown[]) => {
  const install = vi.fn();
  for (const answer of answers) install.mockResolvedValueOnce(answer);
  return install;
};

describe('installing on another computer with the yes given here', () => {
  it('that computer fetches and checks it first, then installs the package agreed to', async () => {
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'digest-agreed' } } }, { success: true }]);
    await installAgreedOn(install, async () => ({ digest: 'digest-agreed' }));
    expect(install.mock.calls).toEqual([[{ kind: 'return' }], [{ kind: 'given', digest: 'digest-agreed' }]]);
  });

  it('refuses a package other than the one agreed to, and installs nothing', async () => {
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'digest-other' } } }]);
    await expect(installAgreedOn(install, async () => ({ digest: 'digest-agreed' }))).rejects.toThrow('another package');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('says why when that computer could not fetch or install it', async () => {
    await expect(installAgreedOn(run([{ success: false, error: 'offline' }]), async () => ({ digest: 'd' }))).rejects.toThrow('offline');
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'd' } } }, { success: false, error: 'disk full' }]);
    await expect(installAgreedOn(install, async () => ({ digest: 'd' }))).rejects.toThrow('disk full');
  });

  it('E-05 there (what that computer has did not come from a chat): fails with its reason, never counted as installed', async () => {
    const install = run([{ success: true, data: { installed: false, outcome: 'refused', reason: 'a package from chat cannot replace it' } }]);
    await expect(installAgreedOn(install, async () => ({ digest: 'd' }))).rejects.toThrow('cannot replace it');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('E-05 at the second step (that computer got the market’s copy while the person read the sheet): fails with its reason', async () => {
    const install = run([
      { success: true, data: { outcome: 'ask', ask: { manifestDigest: 'd' } } },
      { success: true, data: { installed: false, outcome: 'refused', reason: 'a package from chat cannot replace it' } },
    ]);
    await expect(installAgreedOn(install, async () => ({ digest: 'd' }))).rejects.toThrow('cannot replace it');
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('D-31 asked here between the two steps (an agent’s install there): given with where the person ticked', async () => {
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'd' } } }, { success: true, data: { installed: true } }]);
    const agree = vi.fn().mockResolvedValue({ digest: 'd', enableIn: ['agent-1'] });
    await expect(installAgreedOn(install, agree)).resolves.toEqual({ installed: true });
    expect(agree).toHaveBeenCalledWith({ outcome: 'ask', ask: { manifestDigest: 'd' } });
    expect(install.mock.calls[1]).toEqual([{ kind: 'given', digest: 'd', enableIn: ['agent-1'] }]);
  });

  it('owner 10-27 ticked in the sheet = every agent there too: here:all goes with the yes, what that computer gives already kept', async () => {
    const places = [{ id: 'here:all', kind: 'here', enabled: false }, { id: 'g1', kind: 'group', enabled: true }, { id: 'g2', kind: 'group', enabled: false }];
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'd', places } } }, { success: true }]);
    await installAgreedOn(install, async () => ({ digest: 'd' }));
    expect(install.mock.calls[1]).toEqual([{ kind: 'given', digest: 'd', enableIn: ['g1', 'here:all'] }]);
  });

  it('the person says no here: nothing goes in there, and the no is the answer', async () => {
    const install = run([{ success: true, data: { outcome: 'ask', ask: { manifestDigest: 'd' } } }]);
    await expect(installAgreedOn(install, async () => ({ declined: 'cancelled' }))).resolves.toEqual({ declined: 'cancelled' });
    expect(install).toHaveBeenCalledTimes(1);
  });
});
