// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunInstallProvider } from '@/components/firstRun/FirstRunInstallProvider';
import { useFirstRunInstaller } from '@/components/firstRun/first-run-install-context';

const f = vi.hoisted(() => ({ install: vi.fn(), status: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatuses: () => ({ installAsync: f.install }), useAgentInstallProgress: () => null,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { agents: { getAgentInstallationStatus: f.status, cancelInstall: vi.fn() } } }));

function Flow() {
  const queue = useFirstRunInstaller(); const [page, setPage] = useState('choose');
  return page === 'choose' ? <button onClick={() => { queue(['codex', 'claude']); setPage('next'); }}>Continue</button> : <p>Next setup step</p>;
}
let host: HTMLDivElement; let root: Root;
const deferred = () => { let resolve!: (x: { success: boolean }) => void; const promise = new Promise<{ success: boolean }>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.install.mockReset(); f.status.mockReset().mockResolvedValue({ used: { kind: 'method', method: 'mise' }, installations: [{ provenance: { ours: true, kind: 'mise' }, status: 'available' }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('managed installations survive leaving the selection step (#7582)', () => {
  it('tracks both concurrent installs independently after continuing', async () => {
    const codex = deferred(), claude = deferred();
    f.install.mockImplementation(({ id }) => id === 'codex' ? codex.promise : claude.promise);
    await act(async () => root.render(<FirstRunInstallProvider><Flow /></FirstRunInstallProvider>));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Next setup step');
    expect(f.install.mock.calls.map(([x]) => x)).toEqual([{ id: 'codex', method: 'mise' }, { id: 'claude', method: 'mise' }]);
    await act(async () => claude.resolve({ success: true }));
    expect(host.querySelectorAll('[data-testid="install-progress-track"]')).toHaveLength(1);
    await act(async () => codex.resolve({ success: true }));
    expect(host.querySelectorAll('[data-testid="install-progress-track"]')).toHaveLength(0);
    expect(host.textContent?.split('firstRun.harnessInstalled')).toHaveLength(3);
    expect(f.status).toHaveBeenCalledWith('codex'); expect(f.status).toHaveBeenCalledWith('claude');
  });
  it('does not report an external installed copy as a successful managed install', async () => {
    f.install.mockResolvedValue({ success: true });
    f.status.mockResolvedValue({ used: { kind: 'auto' }, installations: [{ provenance: { ours: false, kind: 'path' }, status: 'available' }] });
    await act(async () => root.render(<FirstRunInstallProvider><Flow /></FirstRunInstallProvider>));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(host.textContent).not.toContain('firstRun.harnessInstalled');
  });
});
