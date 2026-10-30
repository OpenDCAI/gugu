import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener) }
}
/** A local offline signal is not evidence that the remote machine is offline. */
export function useNetworkOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
}
