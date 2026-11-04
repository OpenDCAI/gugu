import { ExtensionTaskPages } from './extension-task-pages';
import { extensionsService } from './extensions-root';
import { browserWebContentsRegistry } from '../browser/browser-webcontents-registry';
import { acquireBrowserPage } from '../browser/browser-page-runtime';
import { leasePageProtocol } from '../browser/leased-page-protocol';
import { sessionEvents } from '../sessions/session-events';
import { projectEvents } from '../projects/project-events';
import { BrowserWindow } from 'electron';
import { leaseBrowserPagePresentation, browserPagePresentation, onBrowserPagePresentation } from '../browser/browser-page-views';
import { extensionPagePresentation } from './extension-bridge';
import { log } from '@main/lib/logger';
import type { TaskPageRect } from './extension-task-pages';
import { taskPageViewport } from '@shared/extensions/task-page-viewport';
import { readTaskFilePayloads, taskFilePayloadSource } from './task-file-payloads';

/** The host chooses one task page. Apps never supply contents IDs or partitions. */
export const extensionTaskPages = new ExtensionTaskPages(extensionId => {
  const service = extensionsService();
  service.get(extensionId);
  if (!service.isEnabled(extensionId) || !service.hasCapability(extensionId, 'agents:tools')) {
    throw new Error('App task page access was revoked');
  }
}, async ({ sessionId, url, signal }) => {
  const { agentSessionContext } = await import('./extension-agent-context');
  const { openTaskBrowserPane } = await import('../sessions/session-orchestration');
  const { projectionTaskProject } = await import('./projection-task');
  const projectId = await projectionTaskProject(sessionId);
  signal.throwIfAborted();
  const context = await agentSessionContext(sessionId);
  signal.throwIfAborted();
  if (!context || context.projectId !== projectId) throw new Error('The task has no page on this computer');
  const browserId = await openTaskBrowserPane({ projectId, sessionId }, url ?? 'about:blank', signal);
  signal.throwIfAborted();
  const selected = browserWebContentsRegistry.browsersOfSession(sessionId).find(page => page.browserId === browserId);
  if (!selected || selected.webContents.isDestroyed()) throw new Error('The task page was closed before it could be leased');
  const page = acquireBrowserPage(selected.webContents);
  if (!page) throw new Error('The task page has no native page runtime');
  try {
    const { protocol, cleanup } = leasePageProtocol(selected.webContents, {
      ready: page.ready, capture: params => page.capture(params),
    });
    // Protocol observes this ready promise too; observe it before the first send.
    void page.ready.catch(() => {});
    return { projectId, title: selected.webContents.getTitle(), url: selected.webContents.getURL(), protocol,
      cleanup,
      presentation: () => browserPagePresentation(browserId),
      onPresentation: listener => onBrowserPagePresentation(browserId, listener),
      mount(caller, firstRect) {
        const presentation = extensionPagePresentation(caller);
        const host = BrowserWindow.fromWebContents(presentation.embedder);
        if (!host || host.isDestroyed()) throw new Error('The task App has no native host window');
        const mount = leaseBrowserPagePresentation(browserId, host);
        const layout = (rect: TaskPageRect) => {
          const current = extensionPagePresentation(caller);
          if (current.embedder !== presentation.embedder) throw new Error('The App host window changed');
          mount.layout(taskPageViewport(current.metrics, rect, current.scale));
        };
        try { layout(firstRect); } catch (error) { mount.close(); throw error; }
        return { layout, close: () => mount.close() };
      },
      setActive: (active: boolean) => page.setActive(active), release: () => page.dispose() };
  } catch (error) { page.dispose(); throw error; }
}, error => log.warn('Task page cleanup failed', { error: String(error) }),
async (caller, refs, signal) => readTaskFilePayloads(caller, refs, signal, await taskFilePayloadSource()));

sessionEvents.on('session:archived', sessionId => extensionTaskPages.closeScope({ sessionId }));
projectEvents.on('project:deleted', projectId => extensionTaskPages.closeScope({ projectId }));
