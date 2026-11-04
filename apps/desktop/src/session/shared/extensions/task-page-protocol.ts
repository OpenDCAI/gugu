export type TaskPageEvent =
  | { watchId: string; type: 'message'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { watchId: string; type: 'closed'; reason: string };

export interface TaskPageHost {
  readonly pages?: {
    acquire(args: { watchId: string; url?: string }): Promise<{ id: string; title: string; url: string }>;
    send(args: { id: string; method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown>;
    maintain?(args: { id: string; method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown>;
    release(args: { id: string }): Promise<void>;
    mount(args: { id: string; rect: { x: number; y: number; width: number; height: number } }): Promise<void>;
    unmount(args: { id: string }): Promise<void>;
  };
  onTaskPage?(handler: (event: TaskPageEvent) => void): () => void;
}
