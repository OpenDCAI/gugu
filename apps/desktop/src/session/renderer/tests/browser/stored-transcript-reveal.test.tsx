import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import { askReveal } from '@/hooks/useSourceMessageReveal';
import { publishSelfIdentity } from '@/lib/selfIdentityBridge';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

const calls = vi.hoisted(() => ({ history: vi.fn(), toast: vi.fn(), restore: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessions: { getStoredHistory: calls.history } }) }));
vi.mock('@renderer/features/sessions/restore-session-flow', () => ({ restoreArchivedSession: calls.restore }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: calls.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));

import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { SessionHistoryModal } from '@renderer/features/sessions/history/session-history-modal';
import { TabContent } from '@renderer/features/sessions/history/session-history-tab-view';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turn = (seq: number): TranscriptTurn => ({ id: `${sessionId}:turn:s${seq}`, seq, initiator: 'user',
  outcome: { kind: 'done', reason: 'end_turn' }, items: [
    { kind: 'message', id: `${sessionId}:turn:s${seq}:message:q`, seq: 0, role: 'user', text: `Question ${seq}` },
    { kind: 'message', id: `${sessionId}:turn:s${seq}:message:a`, seq: 1, role: 'assistant', text: `Reply ${seq}` },
  ] });
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(async () => {
  await page.viewport(1000, 900);
  host = document.body.appendChild(document.createElement('div'));
  host.className = 'gugu-skin emlight';
  root = createRoot(host); client = new QueryClient();
  calls.history.mockReset().mockImplementation(async ({ before }: { before?: number }) => before === undefined
    ? { turns: Array.from({ length: 100 }, (_, i) => turn(i + 44)), nextCursor: 44 }
    : { turns: Array.from({ length: 44 }, (_, i) => turn(i)), nextCursor: null });
  calls.toast.mockReset(); calls.restore.mockReset().mockResolvedValue(undefined);
  publishSelfIdentity({ userId: 'owner', displayName: null, guguNumber: null });
});
afterEach(() => { root.unmount(); host.remove(); client.clear(); publishSelfIdentity(null); });

it.each(['dialog', 'tab'] as const)('pages a deep hit into the real folded transcript in the %s host', async kind => {
  const target = turn(34).items[1].id;
  const closed = vi.fn(), restored = vi.fn();
  askReveal(`task:${sessionId}`, messageQuoteLink({ kind: 'session', sessionId, itemId: target }));
  root.render(<QueryClientProvider client={client}>{kind === 'dialog'
    ? <Dialog open onOpenChange={closed}><DialogContent className="sm:max-w-2xl"><SessionHistoryModal
      projectId="project" sessionId={sessionId} title="Archived task" onClose={closed} onSuccess={restored} /></DialogContent></Dialog>
    : <div style={{ width: 672, height: 600, display: 'flex', flexDirection: 'column' }}>
      <div data-testid="terminal">Terminal</div><div style={{ flex: 1, minHeight: 0 }}><TabContent
        host={{ resolvedTabs: [{ isActive: true, kind: 'session-history', resource: { sessionId } }] } as never} /></div>
    </div>}</QueryClientProvider>);
  await until('the old stored page has been requested', () => calls.history.mock.calls.some(([p]) => p.before === 44));
  await until('the deep reply is rendered and flashed', () => !!document.querySelector('.msg-src-flash')?.textContent?.includes('Reply 34'));
  const row = document.querySelector<HTMLElement>(`[data-agent-conversation-message="${target}"]`)!;
  expect(row).not.toBeNull();
  const scroll = row.closest<HTMLElement>('[data-chat-scroll]')!;
  await untilStable('the revealed reply stays in its transcript viewport', () => [scroll.scrollTop, row.getBoundingClientRect().top]);
  expect(scroll.scrollTop).toBeGreaterThan(0);
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().top - 1);
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroll.getBoundingClientRect().bottom + 1);
  expect(calls.toast).not.toHaveBeenCalled();
  expect(calls.restore).not.toHaveBeenCalled();
  if (kind === 'tab') expect(host.querySelector('[data-testid="terminal"]')?.textContent).toBe('Terminal');
  else {
    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const header = dialog.querySelector<HTMLElement>('[data-slot="dialog-header"]')!;
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    const canvas = dialog.querySelector<HTMLElement>('[data-chat-canvas]')!.getBoundingClientRect();
    expect(canvas.top).toBeGreaterThanOrEqual(header.getBoundingClientRect().bottom - 1);
    expect(canvas.bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().top + 1);
    for (const button of [header.querySelector('button')!, footer.querySelector('button')!]) {
      const box = button.getBoundingClientRect();
      expect(button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
    }
    await page.getByRole('button', { name: 'sessionHistory.restore', exact: true }).click();
    expect(calls.restore).toHaveBeenCalledWith({ projectId: 'project', sessionId });
    expect(restored).toHaveBeenCalledOnce();
    await page.elementLocator(header.querySelector('button')!).click();
    expect(closed).toHaveBeenCalled();
  }
});
