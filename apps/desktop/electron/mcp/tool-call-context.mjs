import { AsyncLocalStorage } from 'node:async_hooks'

const invocation = new AsyncLocalStorage()

/** Native tool IDs survive reconnect/replay. Other callers guarantee identity only within an MCP session. */
export function runWithGuguToolInvocation(extra, connectionScope, run) {
  const nativeId = extra._meta?.['claudecode/toolUseId']
  const requestId = extra.requestId
  const id = typeof nativeId === 'string' && nativeId.trim()
    ? JSON.stringify(['claude', nativeId])
    : typeof requestId === 'string' || typeof requestId === 'number'
      ? JSON.stringify(['mcp', extra.sessionId || connectionScope, requestId])
      : undefined
  return invocation.run(id, run)
}

export function currentGuguToolInvocation() {
  return invocation.getStore()
}
