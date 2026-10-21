import { useCallback, useEffect, useRef, useState } from 'react'
import { rendererLogger } from '@/lib/log'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'

const log = rendererLogger('mobile/assistant')

export type PhoneRead<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: unknown }

/** 同一个工作区(机器、项目、工作区、记忆夹)= 同一个键;重新打开过的工作区换键重读。 */
export function machineKey(machine: AssistantMachine): string {
  return `${machine.deviceId}|${machine.projectId}|${machine.workspaceId}|${machine.paths.memoryDir}`
}

/**
 * 手机壳里没有 react-query:读一次、记下是哪一把键的读数(键变了 ❌ 拿旧读数冒充),失败如实交出去由页面说是哪一步。
 * `key` 为 null = 此刻不该读(它在休息、工作区还没打开)。`reload` 从头再读(先回到「在读」);
 * `pollMs` 按读到的东西定下一次悄悄重读(语音笔记还在处理时),悄悄重读失败只记日志、留着上一次的读数。
 */
export function usePhoneRead<T>(
  key: string | null,
  read: () => Promise<T>,
  what: string,
  pollMs?: (data: T) => number | null,
): PhoneRead<T> & { reload: () => void; refresh: () => Promise<void> } {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; read: PhoneRead<T> } | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const pollRef = useRef(pollMs)
  pollRef.current = pollMs
  const full = key === null ? null : `${key}#${attempt}`
  const fullRef = useRef(full)
  fullRef.current = full
  useEffect(() => {
    if (full === null) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 上一次读到后定的间隔:悄悄重读偶尔失败一次不该让它从此不再刷新(「处理中」就一直停在处理中),按同一个间隔接着排下一次。
    let lastInterval: number | null = null
    const run = (quiet: boolean) => {
      Promise.resolve().then(() => readRef.current()).then(
        (data) => {
          if (cancelled) return
          setResult({ key: full, read: { state: 'ok', data } })
          lastInterval = pollRef.current?.(data) ?? null
          if (lastInterval) timer = setTimeout(() => run(true), lastInterval)
        },
        (error: unknown) => {
          if (cancelled) return
          log.warn({ what, quiet, error: error instanceof Error ? error.message : String(error) }, 'assistant phone read failed')
          if (!quiet) setResult({ key: full, read: { state: 'error', error } })
          else if (lastInterval) timer = setTimeout(() => run(true), lastInterval)
        },
      )
    }
    run(false)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [full, what])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  // 改完一样东西之后悄悄重读(开关拨完不让整页闪回「在读」);读失败只记日志,留着上一次的读数。
  const refresh = useCallback(async () => {
    const at = fullRef.current
    if (at === null) return
    try {
      const data = await readRef.current()
      if (fullRef.current === at) setResult({ key: at, read: { state: 'ok', data } })
    } catch (error) {
      log.warn({ what, error: error instanceof Error ? error.message : String(error) }, 'assistant phone refresh failed')
    }
  }, [what])
  const current: PhoneRead<T> = result && result.key === full ? result.read : { state: 'loading' }
  return { ...current, reload, refresh }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
