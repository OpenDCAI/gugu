// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNode, createReactHarness } from '../../../support/testHarness';

const calls = vi.hoisted(() => ({ restore: vi.fn(), toast: vi.fn() }));
vi.mock('@renderer/features/sessions/restore-session-flow', () => ({ restoreArchivedSession: calls.restore }));
vi.mock('@renderer/features/sessions/history/session-history-view', () => ({ SessionHistoryView: () => 'Read-only history' }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: calls.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { SessionHistoryModal } from '@renderer/features/sessions/history/session-history-modal';

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); calls.restore.mockReset(); calls.toast.mockReset(); });
afterEach(() => harness.cleanup());

it('only restores on explicit action, then completes without task navigation or runtime start', async () => {
  const onSuccess = vi.fn(), onClose = vi.fn();
  await harness.render(createNode(Dialog, { open: true }, createNode(DialogContent, {},
    createNode(SessionHistoryModal, { projectId: 'project', sessionId: 'archived', title: 'Old task', onSuccess, onClose }))));
  expect(document.body.textContent).toContain('Old task · globalSearch.archived');
  expect(document.body.textContent).toContain('Read-only history');
  expect(calls.restore).not.toHaveBeenCalled();
  calls.restore.mockRejectedValueOnce(new Error('Restore failed'));
  const restoreButton = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'sessionHistory.restore')!;
  await act(async () => restoreButton().click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Restore failed');
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  calls.restore.mockResolvedValueOnce(undefined);
  await act(async () => restoreButton().click());
  expect(calls.restore.mock.calls).toEqual([[{ projectId: 'project', sessionId: 'archived' }], [{ projectId: 'project', sessionId: 'archived' }]]);
  expect(calls.toast).toHaveBeenCalledWith({ title: 'sessionHistory.restoredToast' });
  expect(onSuccess).toHaveBeenCalledOnce();
});
