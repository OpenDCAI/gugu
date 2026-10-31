import { createContext, useContext, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'

type SettingsDetail = { key: string; title: string; back: () => void }
export type SettingsDetailState = SettingsDetail | null
export const SettingsDetailNavigation = createContext<Dispatch<SetStateAction<SettingsDetailState>> | null>(null)

/** Nested settings keep the modal's single title and round back control. */
export function useSettingsDetail(key: string | null, title: string, back: () => void) {
  const setDetail = useContext(SettingsDetailNavigation)
  const latest = useRef(back)
  latest.current = back
  useLayoutEffect(() => {
    if (!key || !setDetail) return
    const detail = { key, title, back: () => latest.current() }
    setDetail(detail)
    return () => setDetail(current => current === detail ? null : current)
  }, [key, title, setDetail])
  return !!key && !!setDetail
}
