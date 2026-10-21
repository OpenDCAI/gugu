import { useEffect, useRef } from 'react'

type RendererRpcHandler = (params: unknown) => unknown | Promise<unknown>

export type RendererRpcHandlers = Record<string, RendererRpcHandler>

type ListenerRegistry = Record<string, EventListener | undefined>

interface RendererRpcCommand {
  reqId: string
  method: string
  params: unknown
}

interface RendererRpcErrorResult {
  __rendererRpcError: true
  error: string
}

export async function handleRendererRpcEvent(
  event: Event,
  domain: string,
  handlers: RendererRpcHandlers,
  respond: (reqId: string, result: unknown) => void,
): Promise<void> {
  const { reqId, method, params } = (event as CustomEvent<RendererRpcCommand>).detail
  const command = handlers[method]

  let result: unknown
  try {
    // 没注册的方法是接线错了,和处理器抛错走同一种失败形状 —— ❌ 回一个普通对象让主进程当成功值读。
    if (!command) throw new Error(`Unknown ${domain} method: ${method}`)
    result = await command(params)
  } catch (err) {
    result = {
      __rendererRpcError: true,
      error: err instanceof Error ? err.message : 'Unknown error',
    } satisfies RendererRpcErrorResult
  }

  respond(reqId, result)
}

export function useRendererRpcHandlers(
  eventName: string,
  domain: string,
  handlers: RendererRpcHandlers,
  respond: (reqId: string, result: unknown) => void,
  enabled = true,
  declareReady?: () => void,
): void {
  const handlersRef = useRef(handlers)
  const respondRef = useRef(respond)
  const declareReadyRef = useRef(declareReady)
  handlersRef.current = handlers
  respondRef.current = respond
  declareReadyRef.current = declareReady

  useEffect(() => {
    if (!enabled) return undefined

    const registryOwner = window as Window & { __guguRendererRpcListeners?: ListenerRegistry }
    const registry = registryOwner.__guguRendererRpcListeners ??= {}
    const previous = registry[eventName]
    if (previous) {
      window.removeEventListener(eventName, previous)
    }

    const listener = (event: Event) => {
      void handleRendererRpcEvent(event, domain, handlersRef.current, respondRef.current)
    }

    registry[eventName] = listener
    window.addEventListener(eventName, listener)
    declareReadyRef.current?.()
    return () => {
      if (registry[eventName] === listener) {
        window.removeEventListener(eventName, listener)
        delete registry[eventName]
      }
    }
  }, [domain, enabled, eventName])
}
