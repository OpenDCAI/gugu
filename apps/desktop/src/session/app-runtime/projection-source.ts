import type { ProjectionFrame, ProjectionInput, ProjectionHostPacket, ProjectionSourceEvent, ProjectionViewerPacket } from '@shared/extensions/projection-protocol';

export interface ProjectionHost {
  projection?: {
    create(args: { nativeLocalInput?: boolean }): Promise<{ id: string }>;
    publish(args: { id: string; frame: ProjectionFrame }): Promise<void>;
    close(args: { id: string }): Promise<void>;
    closed(args: { id: string; error?: string }): Promise<void>;
    inputResult(args: { id: string; requestId: string; error?: string }): Promise<void>;
    watch(args: { id: string; watchId: string }): Promise<void>;
    unwatch(args: { watchId: string }): Promise<void>;
    send(args: { watchId: string; packet: ProjectionViewerPacket }): Promise<void>;
  };
  onProjection?(handler: (watchId: string, packet: ProjectionHostPacket) => void): () => void;
  onProjectionSource?(handler: (event: ProjectionSourceEvent) => void): () => void;
}

export interface ProjectionDriver {
  nativeLocalInput?: boolean;
  input(input: ProjectionInput, context: { signal: AbortSignal; viewer: string; frame: Pick<ProjectionFrame, 'sequence' | 'width' | 'height'> }): Promise<void>;
  disconnect(viewer: string): Promise<void>;
  refresh(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** No browser/computer driver here: each App supplies its own capture and input implementation. */
export function projectionSources(host: ProjectionHost) {
  const bridge = host.projection!;
  const sources = new Map<string, { driver: ProjectionDriver; requests: Map<string, AbortController>; closing: boolean }>();
  let hearing = false;
  const errorOf = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

  return {
    async create(driver: ProjectionDriver) {
      if (!driver || typeof driver.input !== 'function' || typeof driver.disconnect !== 'function'
        || typeof driver.refresh !== 'function' || typeof driver.close !== 'function') {
        throw new Error('A projection needs input, disconnect, refresh and close handlers');
      }
      if (!hearing) {
        hearing = true;
        host.onProjectionSource!((event) => {
          const source = sources.get(event.id);
          if (!source) return;
          if (event.type === 'cancel') { source.requests.get(event.requestId)?.abort(new Error('Projection input cancelled')); return; }
          if (event.type === 'close') {
            source.closing = true;
            for (const request of source.requests.values()) request.abort(new Error('Projection closed'));
            void Promise.resolve().then(() => source.driver.close()).then(
              () => bridge.closed({ id: event.id }),
              reason => bridge.closed({ id: event.id, error: errorOf(reason) }),
            ).catch(() => undefined).finally(() => sources.delete(event.id));
            return;
          }
          if (source.closing) return;
          if (event.type === 'refresh') {
            void Promise.resolve().then(() => source.driver.refresh()).catch(() => bridge.close({ id: event.id })).catch(() => undefined);
            return;
          }
          if (event.type === 'disconnect') {
            void Promise.resolve().then(() => source.driver.disconnect(event.viewer)).then(
              () => bridge.inputResult({ id: event.id, requestId: event.requestId }),
              reason => bridge.inputResult({ id: event.id, requestId: event.requestId, error: errorOf(reason) }),
            ).catch(() => undefined);
            return;
          }
          const controller = new AbortController();
          source.requests.set(event.requestId, controller);
          void Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return source.driver.input(event.input, { signal: controller.signal, viewer: event.viewer, frame: event.frame });
          }).then(
            () => bridge.inputResult({ id: event.id, requestId: event.requestId }),
            reason => bridge.inputResult({ id: event.id, requestId: event.requestId, error: errorOf(reason) }),
          ).catch(() => undefined).finally(() => source.requests.delete(event.requestId));
        });
      }
      const { id } = await bridge.create({ ...(driver.nativeLocalInput === true ? { nativeLocalInput: true } : {}) });
      const source = { driver, requests: new Map<string, AbortController>(), closing: false };
      sources.set(id, source);
      let sequence = 0;
      return Object.freeze({
        id,
        publish(frame: Omit<ProjectionFrame, 'sequence'>) {
          if (source.closing) return Promise.reject(new Error('Projection closed'));
          return bridge.publish({ id, frame: { ...frame, sequence: ++sequence } });
        },
        close: () => bridge.close({ id }),
      });
    },
  };
}
