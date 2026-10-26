import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { i18n } from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { rendererLogger } from '@/lib/log'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { ASSISTANT_PANEL_CHANGED } from '@/components/assistant/assistant-panel-events'
import { isAssistantPanelReadRetryable, withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'

const log = rendererLogger('mobile/assistant')

export type PhoneRead<T> = { state: 'loading' } | { state: 'ok'; data: T; refreshError?: unknown } | { state: 'error'; error: unknown }

/** 同一个工作区(机器、项目、工作区、记忆夹)= 同一个键;重新打开过的工作区换键重读。 */
export function machineKey(machine: AssistantMachine): string {
  return `${machine.deviceId}|${machine.projectId}|${machine.workspaceId}|${machine.paths.memoryDir}`
}

/**
 * 手机壳里没有 react-query:读一次、记下是哪一把键的读数(键变了 ❌ 拿旧读数冒充),失败如实交出去由页面说是哪一步。
 * `key` 为 null = 此刻不该读(它在休息、工作区还没打开)。`reload` 从头再读(先回到「在读」);
 * `pollMs` 按读到的东西定下一次悄悄重读(语音笔记还在处理时),悄悄重读失败也如实显示，并继续安排刷新。
 */
export function usePhoneRead<T>(
  key: string | null,
  read: () => Promise<T>,
  what: string,
  pollMs?: (data: T) => number | null,
): PhoneRead<T> & { reload: () => void; refresh: () => Promise<void> } {
  const [result, setResult] = useState<{ key: string; read: PhoneRead<T> } | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const pollRef = useRef(pollMs)
  pollRef.current = pollMs
  const full = key
  const fullRef = useRef(full)
  fullRef.current = full
  const refreshRef = useRef<{ key: string; run: () => Promise<void>; reload: () => void } | null>(null)
  useEffect(() => {
    if (full === null) return
    let cancelled = false
    let request = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // 上一次读到后定的间隔:悄悄重读偶尔失败一次不该让它从此不再刷新(「处理中」就一直停在处理中),按同一个间隔接着排下一次。
    let lastInterval: number | null = null
    const run = async (quiet: boolean, explicit = false): Promise<void> => {
      clearTimeout(timer)
      const current = ++request
      const active = () => !cancelled && fullRef.current === full && current === request
      try {
        const data = await withAssistantPanelReadDeadline(() => readRef.current())
        if (!active()) return
        lastInterval = pollRef.current?.(data) ?? null
        setResult({ key: full, read: { state: 'ok', data } })
        if (lastInterval) timer = setTimeout(() => void run(true), lastInterval)
      } catch (error) {
        if (!active()) return
        log.warn({ what, quiet, error: error instanceof Error ? error.message : String(error) }, 'assistant phone read failed')
        setResult(previous => quiet && previous?.key === full && previous.read.state === 'ok'
          ? { ...previous,read: { ...previous.read,refreshError: error } } : { key: full,read: { state: 'error',error } })
        if (isAssistantPanelReadRetryable(error)) timer = setTimeout(() => void run(true),lastInterval ?? 5000)
        // A requested refresh must not turn a failed verification into a successful mutation.
        if (explicit) throw error
      }
    }
    const refresher = { key: full, run: () => run(false, true),reload: () => { void run(true) } }
    refreshRef.current = refresher
    const changed = () => { void run(true) }
    window.addEventListener(ASSISTANT_PANEL_CHANGED,changed)
    void run(false)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener(ASSISTANT_PANEL_CHANGED,changed)
      if (refreshRef.current === refresher) refreshRef.current = null
    }
  }, [full, what])
  const reload = useCallback(() => refreshRef.current?.reload(), [])
  // 改完后重读不闪回「在读」；失败交给页面重试，并让调用方知道尚未核对成功。
  const refresh = useCallback(async () => {
    const reader = refreshRef.current
    if (reader && reader.key === fullRef.current) await reader.run()
  }, [])
  const current: PhoneRead<T> = result && result.key === full ? result.read : { state: 'loading' }
  return { ...current, reload, refresh }
}

export function errorText(error: unknown): string {
  return assistantPanelFailure(error,(key,values) => i18n.t(`assistant:${key}`,values))
}
