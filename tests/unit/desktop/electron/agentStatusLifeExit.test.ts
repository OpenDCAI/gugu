import { expect, it, vi } from 'vitest';
import type { LifeStatus, LifeView } from '@shared/core/sessions/session-life';
import { displayStatus } from '@shared/core/sessions/session-life';
import type { AgentStatusChange } from '@shared/core/sessions/sessionEvents';

// These boundaries need no Electron, credentials or roster I/O. The feed and its real lifecycle
// composition run below; the original roster integration file remains a separate resource check.
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({ onSessionpageAgentProvisioned: () => () => {} }));
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent', () => ({ guguAgentUserIdForSession: async () => 'agent' }));
import { AgentStatusFeed } from '../../../../apps/desktop/electron/sessionpage/agent-status-feed';

it('forwards only the lifecycle owner process-exit fact and clears it on the next admitted generation', async () => {
  let life: LifeStatus = { kind: 'ready', stage: null };
  let onLife!: (view: LifeView) => void;
  const ready = Promise.withResolvers<void>();
  const change: AgentStatusChange = { sessionId: 's', projectId: 'p',
    reading: { status: 'working', detail: 'running', running: true, background: null },
    unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null };
  const feed = new AgentStatusFeed();
  feed.subscribe(() => ready.resolve());
  feed.attach({ onAgentStatus: () => () => {}, agentStatusSnapshot: async () => [change],
    onSessionsGone: () => () => {}, onSessionLifeView: cb => { onLife = cb; return () => {}; }, sessionLifeStatusOf: () => life }, { env: {} });
  const move = (value: LifeStatus) => { life = value; onLife({ sessionId: 's' } as LifeView); };
  try {
    await ready.promise;
    expect(displayStatus(feed.get('agent')!.life!, 'working')).toBe('working');
    move({ kind: 'dormant', stage: null });
    expect(displayStatus(feed.get('agent')!.life!, 'working')).toBe('working');
    move({ kind: 'dormant', stage: null, processExited: true });
    expect(feed.get('agent')!.life).toEqual({ kind: 'dormant', stage: null, processExited: true });
    expect(displayStatus(feed.get('agent')!.life!, 'working')).toBe('offline');
    expect(displayStatus(feed.get('agent')!.life!, 'error')).toBe('error');
    expect(feed.get('agent')!.reading).toEqual(change.reading);
    move({ kind: 'ready', stage: null, processExited: false });
    expect(displayStatus(feed.get('agent')!.life!, 'working')).toBe('working');
  } finally { feed.dispose(); }
});
