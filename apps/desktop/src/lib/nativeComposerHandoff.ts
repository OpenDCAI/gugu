/** One in-window handoff, shared across the shell and session renderer module graphs. */
export type NativeComposerDraft = { text: string; files?: File[]; append?: boolean }
type Receiver = (draft: NativeComposerDraft) => void | Promise<void>
const KEY = '__GUGU_NATIVE_COMPOSERS__'
const READY = 'gugu:native-composer-ready'
function receivers(): Map<string, Receiver> {
  const host = window as unknown as Record<string, Map<string, Receiver>>
  return host[KEY] ??= new Map()
}
export function registerNativeComposer(sessionId: string, receive: Receiver): () => void {
  receivers().set(sessionId, receive)
  window.dispatchEvent(new Event(READY))
  return () => { if (receivers().get(sessionId) === receive) receivers().delete(sessionId) }
}
export async function handoffNativeComposer(sessionId: string, draft: NativeComposerDraft): Promise<void> {
  const receive = receivers().get(sessionId) ?? await new Promise<Receiver>((resolve, reject) => {
    const clear = () => { clearTimeout(timer); window.removeEventListener(READY, ready) }
    const ready = () => { const receive = receivers().get(sessionId); if (receive) { clear(); resolve(receive) } }
    const timer = setTimeout(() => { clear(); reject(new Error('会话输入框尚未就绪，草稿已保留')) }, 10_000)
    window.addEventListener(READY, ready)
    ready()
  })
  await receive(draft)
}
