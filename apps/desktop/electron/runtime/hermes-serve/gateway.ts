// JSON-RPC over the `hermes serve` WebSocket (`/api/ws?token=`): requests out, events and server requests in.
import type { Json } from './mapping.ts';

export type GatewayEvent = { type: string; runtimeSessionId: string; payload: Json };

export type Gateway = {
  request(method: string, params: Json): Promise<Json>;
  close(): void;
};

export class GatewayError extends Error {
  code: number;
  data: unknown;
  constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
    super(`hermes ${method}: ${error.message ?? 'request failed'}`);
    this.code = typeof error.code === 'number' ? error.code : -32603;
    this.data = error.data;
  }
}

/** Resolves once Hermes emits `gateway.ready` on the new connection. */
export function connectGateway(port: number, token: string, handlers: {
  onEvent(event: GatewayEvent): void;
  /** A server→client request (`approval`, `clarify`, …); the resolved value is the JSON-RPC result. */
  onServerRequest(method: string, params: Json): Promise<Json>;
  onClose(reason: string): void;
}): Promise<Gateway> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
  const pending = new Map<number, { method: string; resolve(value: Json): void; reject(error: Error): void }>();
  let nextId = 1;
  let open = false;
  const send = (message: Json) => socket.send(JSON.stringify(message));
  const failPending = (reason: string) => {
    for (const entry of pending.values()) entry.reject(new Error(`hermes ${entry.method}: ${reason}`));
    pending.clear();
  };
  const gateway: Gateway = {
    request(method, params) {
      if (!open) return Promise.reject(new Error(`hermes ${method}: gateway connection is closed`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    close: () => socket.close(),
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      let message: Json;
      try {
        message = JSON.parse(String(event.data)) as Json;
      } catch {
        process.stderr.write(`[hermes-serve-acp] non-JSON gateway frame: ${String(event.data).slice(0, 200)}\n`);
        return;
      }
      const id = message.id;
      if (typeof id === 'number' && message.method === undefined) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (message.error) entry.reject(new GatewayError(entry.method, message.error as Json));
        else entry.resolve((message.result ?? {}) as Json);
        return;
      }
      if (message.method === 'event') {
        const params = (message.params ?? {}) as Json;
        const type = String(params.type ?? '');
        if (type === 'gateway.ready' && !open) {
          open = true;
          resolve(gateway);
        }
        handlers.onEvent({ type, runtimeSessionId: String(params.session_id ?? ''), payload: (params.payload ?? {}) as Json });
        return;
      }
      if (typeof message.method === 'string' && id !== undefined) {
        const method = message.method;
        handlers.onServerRequest(method, (message.params ?? {}) as Json).then(
          (result) => send({ jsonrpc: '2.0', id, result }),
          (error: Error) => send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }),
        );
      }
    });
    socket.addEventListener('error', () => {
      if (!open) reject(new Error(`could not connect to hermes serve on port ${port}`));
    });
    socket.addEventListener('close', (event) => {
      const reason = `gateway connection closed (code=${event.code})`;
      open = false;
      failPending(reason);
      reject(new Error(reason));
      handlers.onClose(reason);
    });
  });
}
