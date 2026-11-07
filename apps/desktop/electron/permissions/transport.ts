import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { PermissionCaller } from './operation'
import type { PermissionAttempt, ServicePermissionRuntime } from './runtime'

/**
 * At the authenticated host transport, before SDK dispatch and before its response reaches the harness.
 * Covers registered tools AND custom App/connected-service handlers, including catalog payloads.
 * No SDK private handler tables, second executor, or model-provided identity is needed.
 */
export function permissionTransport(inner: Transport, runtime: ServicePermissionRuntime, caller: PermissionCaller, parent: AbortSignal): Transport {
  const calls = new Map<RequestId, { controller: AbortController; attempt?: PermissionAttempt }>()
  const abort = () => { for (const call of calls.values()) call.controller.abort() }
  parent.addEventListener('abort', abort, { once: true })
  const transport: Transport = {
    get sessionId() { return inner.sessionId },
    setProtocolVersion: version => inner.setProtocolVersion?.(version),
    async start() {
      inner.onerror = error => transport.onerror?.(error)
      inner.onclose = () => { abort(); calls.clear(); parent.removeEventListener('abort', abort); transport.onclose?.() }
      inner.onmessage = (message, extra) => {
        if ('method' in message && message.method === 'notifications/cancelled') {
          const params = message.params as { requestId?: RequestId } | undefined
          if (params?.requestId !== undefined) calls.get(params.requestId)?.controller.abort()
        }
        if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) {
          transport.onmessage?.(message, extra)
          return
        }
        const id = message.id
        if (calls.has(id)) {
          void inner.send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Duplicate active request ID' } }).catch(error => transport.onerror?.(error))
          return
        }
        const call: { controller: AbortController; attempt?: PermissionAttempt } = { controller: new AbortController() }
        calls.set(id, call)
        if (parent.aborted) call.controller.abort()
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined
        const receive = async () => {
          call.attempt = await runtime.begin(caller, typeof params?.name === 'string' ? params.name : '', params?.arguments, call.controller.signal)
          if (!call.attempt.execute || call.controller.signal.aborted) {
            calls.delete(id)
            await inner.send({ jsonrpc: '2.0', id, result: call.controller.signal.aborted
              ? { content: [{ type: 'text', text: 'request_cancelled' }], isError: true } : call.attempt.refusal })
            return
          }
          transport.onmessage?.(message, extra)
        }
        void receive().catch(async () => {
          calls.delete(id)
          await inner.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'permission_unavailable' }], isError: true } })
        }).catch(error => transport.onerror?.(error))
      }
      await inner.start()
    },
    async send(message, options) {
      if ('id' in message && message.id !== undefined && !('method' in message)) {
        const call = calls.get(message.id)
        if (call?.attempt) {
          calls.delete(message.id)
          const failed = 'error' in message || 'result' in message && (message.result as { isError?: boolean })?.isError === true
          const output = await call.attempt.finish('result' in message ? message.result : message.error, failed)
          if ('result' in message && output === message.result || 'error' in message && output === message.error) return inner.send(message, options)
          return inner.send({ jsonrpc: '2.0', id: message.id, result: output } as JSONRPCMessage, options)
        }
      }
      return inner.send(message, options)
    },
    async close() { abort(); parent.removeEventListener('abort', abort); await inner.close() },
  }
  return transport
}
