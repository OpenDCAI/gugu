/**
 * Task-view tab registry.
 *
 * Instantiates the generic `createTabView` factory with the five task-specific
 * providers and wires in the task persistence adapter.
 *
 * `sessionTabView` is the singleton for task views; import from it to get typed
 * store-creator, hook, and derived types:
 *
 *   const paneLayout = sessionTabView.createPaneLayoutStore(ctx);
 *   paneLayout.open('file', { path: '/foo.ts' });   // typed ✓
 *
 * `SessionTabKind`, `SessionOpenArgsOf`, etc. are derived from the provider set,
 * so they stay in sync automatically.
 */

import { browserTabProvider } from '@renderer/features/browser/browser-tab-provider';
import { type KindOf, type OpenArgsOf } from '@renderer/features/tabs/core/tab-provider-registry';
import { createTabView } from '@renderer/features/tabs/tab-view-factory';
import { acpChatTabProvider } from './acp/acp-chat-tab-provider';
import { sideChatTabProvider } from './acp/side-chat-tab-provider';
import { sessionHistoryTabProvider } from './history/session-history-tab';
import { sessionTabProvider } from './session-tab-provider';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { diffTabProvider } from './diff-view/diff-tab-provider';
import { reviewTabProvider } from './diff-view/review-tab-provider';
import { fileBrowserTabProvider } from './editor/file-browser-tab-provider';
import { fileTabProvider } from './editor/file-tab-provider';
import { createSessionTabPersistor } from './stores/session-tab-view-persistor';
import { terminalTabProvider } from './terminals/terminal-tab-provider';
import { remotePortsTabProvider } from '../remote-hosts/workspace/remote-ports-tab';

export const sessionTabView = createTabView(
  [
    sessionTabProvider,
    acpChatTabProvider,
    sideChatTabProvider,
    sessionHistoryTabProvider,
    fileBrowserTabProvider,
    fileTabProvider,
    reviewTabProvider,
    diffTabProvider,
    browserTabProvider,
    terminalTabProvider,
    // #6264 别的机器上的会话才有的「端口」(照 VS Code Ports 视图);本机会话的清单里没有这一项。
    remotePortsTabProvider
  ] as const,
  { makePersistor: (ctx) => createSessionTabPersistor(ctx as SessionTabContext) }
);

type SessionRegistry = typeof sessionTabView.registry;

export type SessionTabKind = KindOf<SessionRegistry>;
export type SessionOpenArgsOf<K extends SessionTabKind> = OpenArgsOf<SessionRegistry, K>;

export const { useTabLayout, useTabSelection, TabLayoutProvider } = sessionTabView;

// Keep the registry export for consumers that still import it directly.
export const sessionTabRegistry = sessionTabView.registry;
