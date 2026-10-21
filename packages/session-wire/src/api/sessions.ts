import type { Unsubscribe } from '@gugu/session-shared';
import type { Controller } from './controller';
import type { WireTransport } from './protocol';
import { serve } from './serve';

export type WireSessionHub = {
  open(connectionId: string | number, transport: WireTransport): Unsubscribe;
  close(connectionId: string | number): void;
  dispose(): void;
};

type SessionRecord = {
  dispose: Unsubscribe;
  disconnect: Unsubscribe;
  transport: WireTransport;
};

export function createWireSessionHub(controller: Controller): WireSessionHub {
  const connections = new Map<string, SessionRecord>();

  function close(connectionId: string | number): void {
    const key = String(connectionId);
    const session = connections.get(key);
    if (!session) return;
    connections.delete(key);
    session.disconnect();
    session.dispose();
    session.transport.close?.();
  }

  return {
    open(connectionId, transport) {
      const key = String(connectionId);
      close(key);
      const dispose = serve(transport, controller);
      const disconnect = transport.onDisconnect(() => close(key));
      connections.set(key, { dispose, disconnect, transport });
      return () => close(key);
    },
    close,
    dispose() {
      for (const key of [...connections.keys()]) close(key);
      controller.dispose?.();
    },
  };
}
