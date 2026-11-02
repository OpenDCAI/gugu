import { useEffect } from 'react'
import { useMobileShell } from '@/hooks/useMobileShell'

const nonTextInputs = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

function singleLineInput(event: Event): HTMLInputElement | null {
  const target = event.composedPath()[0]
  return target instanceof HTMLInputElement && !nonTextInputs.has(target.type) ? target : null
}

/** One document owner covers login, the phone shell and portaled sheets alike. */
export function installPhoneImeDismiss(doc: Document): () => void {
  const composing = new WeakSet<HTMLInputElement>()
  const pending = new Set<number>()
  const start = (event: CompositionEvent) => { const input = singleLineInput(event); if (input) composing.add(input) }
  const end = (event: CompositionEvent) => { const input = singleLineInput(event); if (input) composing.delete(input) }
  const keydown = (event: KeyboardEvent) => {
    if ((event.key !== 'Enter' && event.keyCode !== 13) || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return
    const input = singleLineInput(event)
    if (!input || composing.has(input)) return
    // Let target handlers and the browser's implicit form submission finish first.
    // Blur only the original input: a form may deliberately focus its next field.
    const timer = window.setTimeout(() => {
      pending.delete(timer)
      if (input.isConnected && doc.activeElement === input && !composing.has(input)) input.blur()
    }, 0)
    pending.add(timer)
  }
  doc.addEventListener('compositionstart', start, true)
  doc.addEventListener('compositionend', end, true)
  doc.addEventListener('keydown', keydown, true)
  return () => {
    doc.removeEventListener('compositionstart', start, true)
    doc.removeEventListener('compositionend', end, true)
    doc.removeEventListener('keydown', keydown, true)
    for (const timer of pending) window.clearTimeout(timer)
  }
}

export function usePhoneImeDismiss(): void {
  const mobile = useMobileShell()
  useEffect(() => {
    if (mobile) return installPhoneImeDismiss(document)
  }, [mobile])
}
