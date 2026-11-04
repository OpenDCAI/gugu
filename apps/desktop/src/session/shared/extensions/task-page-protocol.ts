import type { TaskPageFileRef, TaskPageFilePayload } from './task-page-files';

/** Native page geometry, measured by the host. CSS page points scale by zoomFactor into bounds. */
export type TaskPagePresentation = {
  space: 'screen-dip';
  bounds: { x: number; y: number; width: number; height: number };
  clip: { x: number; y: number; width: number; height: number };
  zoomFactor: number;
  relativeTo: { windowId: string };
};

export type TaskPageEvent =
  | { watchId: string; type: 'message'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { watchId: string; type: 'presentation'; presentation: TaskPagePresentation | null }
  | { watchId: string; type: 'closed'; reason: string };

export interface TaskPageHost {
  readonly pages?: {
    acquire(args: { watchId: string; url?: string }): Promise<{ id: string; title: string; url: string }>;
    send(args: { id: string; method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown>;
    maintain?(args: { id: string; method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown>;
    presentation?(args: { id: string }): Promise<TaskPagePresentation | null>;
    filePayloads?(args: { id: string; refs: readonly TaskPageFileRef[] }): Promise<TaskPageFilePayload[]>;
    release(args: { id: string }): Promise<void>;
    mount(args: { id: string; rect: { x: number; y: number; width: number; height: number } }): Promise<void>;
    unmount(args: { id: string }): Promise<void>;
  };
  onTaskPage?(handler: (event: TaskPageEvent) => void): () => void;
}
