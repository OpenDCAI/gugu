import { withAssistantPanelReadDeadline } from './assistantPanelRead'

// Shared by all file views in the shell, including previews mounted together.
let active = 0
const waiting: Array<() => void> = []
const downloads = new Map<string,Promise<Uint8Array>>()
function drain() { while (active < 4 && waiting.length) waiting.shift()!() }
export function queuedAssistantPanelBody(key: string,read: (signal: AbortSignal) => Promise<Uint8Array>): Promise<Uint8Array> {
  const existing = downloads.get(key)
  if (existing) return existing
  const result = withAssistantPanelReadDeadline(signal => new Promise<Uint8Array>((resolve,reject) => {
    const cancel = () => { const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index,1); reject(signal.reason) }
    const start = () => {
      signal.removeEventListener('abort',cancel)
      if (signal.aborted) { reject(signal.reason); return }
      active++
      Promise.resolve().then(() => read(signal)).then(resolve,reject).finally(() => { active--;drain() })
    }
    signal.addEventListener('abort',cancel,{ once: true })
    waiting.push(start);drain()
  }))
  downloads.set(key,result)
  void result.finally(() => { if (downloads.get(key) === result) downloads.delete(key) }).catch(() => {})
  return result
}
