import { BrowserWindow } from 'electron';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { log } from '@main/lib/logger';
import type { ResourceContext } from '@shared/resource-monitor';

/** Uses existing main-process facts without waking a renderer or installing a timer. */
export async function collectResourceContext(): Promise<ResourceContext> {
  const windows = BrowserWindow.getAllWindows().map((w) => ({ id: w.id, title: w.getTitle(), focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() }));
  const context: ResourceContext = { windows };
  try {
    const tasks = await agentStatusWriter.snapshot();
    context.localTasks = { total: tasks.length, running: 0, waiting: 0, scheduled: 0, unknown: 0 };
    for (const { reading } of tasks) {
      if (!reading) context.localTasks.unknown++;
      else if (reading.status === 'needs_user') context.localTasks.waiting++;
      else if (reading.running || reading.background === 'running') context.localTasks.running++;
      else if (reading.background === 'scheduled') context.localTasks.scheduled++;
    }
  } catch (error) {
    log.warn('resource monitor runtime context unavailable', error);
    context.unavailable = 'Local runtime state unavailable';
  }
  return context;
}
