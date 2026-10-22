import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { getMainWindow } from '@main/app/window';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { log } from '@main/lib/logger';
import { RESOURCE_CONTEXT_REQUEST, resourceUiContextSchema, type ResourceContext } from '@shared/resource-monitor';

let pending: { id: string; resolve: (value: unknown) => void } | null = null;
export function reportResourceContext(id: string, value: unknown): void { if (pending?.id === id) pending.resolve(value); }

/** One request on the sampler's clock. No background renderer polling or network reads. */
export async function collectResourceContext(): Promise<ResourceContext> {
  const windows = BrowserWindow.getAllWindows().map((w) => ({ id: w.id, focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() }));
  const context: ResourceContext = { windows };
  const main = getMainWindow();
  const ui = new Promise<void>((resolve) => {
    if (!main || main.isDestroyed()) { context.unavailable = 'main window unavailable'; resolve(); return; }
    const id = randomUUID();
    const finish = (value: unknown) => {
      clearTimeout(timeout);
      pending = null;
      const parsed = resourceUiContextSchema.safeParse(value);
      if (parsed.success) context.ui = { ...parsed.data, auxiliaryWindows: Math.max(0, windows.length - 1) };
      else context.unavailable = [context.unavailable, 'UI context unavailable or invalid'].filter(Boolean).join('; ');
      resolve();
    };
    const timeout = setTimeout(() => finish(null), 1000);
    pending = { id, resolve: finish };
    try { main.webContents.send(RESOURCE_CONTEXT_REQUEST, { id }); }
    catch { finish(null); }
  });
  try {
    const tasks = await agentStatusWriter.snapshot();
    context.localTasks = { running: 0, waiting: 0, scheduled: 0, unknown: 0 };
    for (const { reading } of tasks) {
      if (!reading) context.localTasks.unknown++;
      else if (reading.status === 'needs_user') context.localTasks.waiting++;
      else if (reading.running || reading.background === 'running') context.localTasks.running++;
      else if (reading.background === 'scheduled') context.localTasks.scheduled++;
    }
  } catch (error) {
    log.warn('resource monitor runtime context unavailable', error);
    context.unavailable = [context.unavailable, 'Local runtime state unavailable'].filter(Boolean).join('; ');
  }
  await ui;
  if (context.ui?.remoteOpenedTasks) context.remoteTasks = { unavailable: 'Remote runtime state is not sampled on this host' };
  return context;
}
