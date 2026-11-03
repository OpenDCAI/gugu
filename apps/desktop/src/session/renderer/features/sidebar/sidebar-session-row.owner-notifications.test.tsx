import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('./sidebar-list-switch', () => ({ SidebarUnreadCount: ({ count }: { count: number }) => count > 0 ? <span data-notification-count={count}>{count}</span> : null }));
import { SessionRowShell, type SessionRowShellProps } from './sidebar-session-row';

const props: SessionRowShellProps = { sessionId: 'session', rowVariant: 'tree', depth: 0, hasChildren: false, expanded: false,
  needsAttention: false, title: 'Task', harness: null, presentation: null, lastInteractedAt: null, doneUnread: false,
  isActive: false, isCursor: false, isPendingArchive: false, quickActions: null, onOpen: () => {}, notificationCount: 2 };

it('gives an error or approval priority over unread notifications in the existing status slot', () => {
  for (const reading of [{ status: 'needs_user', detail: 'approval' }, { status: 'error', detail: 'plain' }] as const) {
    const html = renderToStaticMarkup(<SessionRowShell {...props} presentation={presentAgentStatus({ reading })} />);
    expect(html).not.toContain('data-notification-count');
    expect(html).toContain(reading.status === 'error' ? 'agentStatus.error' : 'agentStatus.needsApproval');
  }
  const subtree = renderToStaticMarkup(<SessionRowShell {...props} needsAttention />);
  expect(subtree).not.toContain('data-notification-count');
  expect(subtree).toContain('sidebar.sessionTreeNeedsAttention');
  const resolved = renderToStaticMarkup(<SessionRowShell {...props} presentation={presentAgentStatus({ reading: { status: 'idle', detail: 'plain' } })} />);
  expect(resolved).toContain('data-notification-count="2"');
});
