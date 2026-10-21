import { HookCore, type Hookable } from '@main/lib/hookable';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { projectCreatedChannel, projectDeletedChannel } from '@shared/core/projects/projectEvents';
import type { Project } from '@shared/projects';

export type ProjectCrudHooks = {
  'project:created': (project: Project) => void | Promise<void>;
  'project:deleted': (projectId: string) => void | Promise<void>;
};

class ProjectEvents implements Hookable<ProjectCrudHooks> {
  private readonly _core = new HookCore<ProjectCrudHooks>((name, e) =>
    log.error(`ProjectEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof ProjectCrudHooks>(name: K, handler: ProjectCrudHooks[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof ProjectCrudHooks>(name: K, ...args: Parameters<ProjectCrudHooks[K]>): void {
    if (name === 'project:created') {
      events.emit(projectCreatedChannel, { project: args[0] as Project });
    }
    if (name === 'project:deleted') {
      events.emit(projectDeletedChannel, { projectId: args[0] as string });
    }
    this._core.callHookBackground(name, ...args);
  }
}

export const projectEvents = new ProjectEvents();
