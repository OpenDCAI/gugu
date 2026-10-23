import { useLayoutEffect, useState } from 'react'

export interface PhoneViewport {
  /** null leaves sizing to CSS (disabled, hidden, or temporarily unmeasurable). Never zero. */
  viewportHeight: number | null
  viewportOffsetTop: number
  /** A real editable control has focus; this does not claim that an IME is visible. */
  inputFocused: boolean
  /** Android WindowInsets IME visibility; null means no current native observation. */
  keyboardVisible: boolean | null
}

const INACTIVE: PhoneViewport = { viewportHeight: null, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null }
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number'])

function editableFocused(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active.closest('[inert]')) return false
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly
  if (active instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(active.type) && !active.disabled && !active.readOnly
  const editable = active.closest('[contenteditable]')
  return editable !== null && ['true', '', 'plaintext-only'].includes(editable.getAttribute('contenteditable') ?? '')
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readViewport(keyboardVisible: boolean | null = null): PhoneViewport {
  if (document.visibilityState === 'hidden') return INACTIVE
  const viewport = window.visualViewport
  // Pinch zoom belongs to the browser. Reflowing the shell to the zoomed rectangle would zoom it twice.
  const useVisual = viewport && viewport.scale === 1 && positive(viewport.height)
  const height = useVisual ? viewport.height : window.innerHeight
  const offset = useVisual ? viewport.offsetTop : 0
  return {
    viewportHeight: positive(height) ? height : null,
    viewportOffsetTop: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    inputFocused: editableFocused(),
    keyboardVisible,
  }
}

/**
 * Phone-shell geometry, including Android adjustResize and browsers that resize only the visual viewport.
 * No screen-size or height-loss heuristic identifies a keyboard: a floating window and rotation also resize.
 * Native keyboardVisible takes precedence over inputFocused; unknown browsers can fall back to focus.
 * Pass the existing useMobileShell result so Electron and a wide desktop web view remain untouched.
 */
export function usePhoneViewport(enabled: boolean): PhoneViewport {
  const [snapshot, setSnapshot] = useState<PhoneViewport>(() => enabled ? readViewport() : INACTIVE)
  useLayoutEffect(() => {
    if (!enabled) return
    let live = true
    let keyboardVisible: boolean | null = null
    const update = () => {
      if (!live) return
      if (document.visibilityState === 'hidden') keyboardVisible = null
      const next = readViewport(keyboardVisible)
      setSnapshot((current) => current.viewportHeight === next.viewportHeight
        && current.viewportOffsetTop === next.viewportOffsetTop && current.inputFocused === next.inputFocused
        && current.keyboardVisible === next.keyboardVisible ? current : next)
    }
    const onKeyboard = (event: Event) => {
      // Capacitor.triggerWindowJSEvent copies JSON fields onto Event itself, not CustomEvent.detail.
      const visible: unknown = (event as Event & { visible?: unknown }).visible
      if (!live || document.visibilityState === 'hidden' || typeof visible !== 'boolean') return
      keyboardVisible = visible
      update()
    }
    // focusout runs before document.activeElement settles; focusin handles a move to another input synchronously.
    const afterFocus = () => { queueMicrotask(update) }
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.addEventListener('pageshow', update)
    window.addEventListener('gugu:phone-keyboard', onKeyboard)
    document.addEventListener('visibilitychange', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', afterFocus)
    update()
    return () => {
      live = false
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('pageshow', update)
      window.removeEventListener('gugu:phone-keyboard', onKeyboard)
      document.removeEventListener('visibilitychange', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', afterFocus)
    }
  }, [enabled])
  return enabled ? snapshot : INACTIVE
}
