import { useSyncExternalStore } from 'react'
import type { LocalePreference } from './locale'
import {
  getLocaleSnapshot,
  setLocalePreference,
  subscribeLocale,
} from './runtime'

export function useLocale(): ReturnType<typeof getLocaleSnapshot> & {
  setPreference: (preference: LocalePreference) => void
} {
  const state = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  return { ...state, setPreference: setLocalePreference }
}

