import { useEffect, useSyncExternalStore } from 'react'
import { readIdentityDirectoryBridge } from './identityDirectoryBridge'
import { readAssistantShellBridge } from './assistantShellBridge'
import { readPhoneAssistantIdentity, usePhoneAssistantIdentity } from '../mobile/assistant/phoneAssistantIdentity'

const noopSubscribe = () => () => {}

/** Group tiles carry ids, not identity types. Read the host's existing directory, without another cache. */
export function useAvatarIdentity(id: string) {
  const bridge = readIdentityDirectoryBridge()
  const identity = useSyncExternalStore(
    bridge?.subscribe ?? noopSubscribe,
    () => bridge?.getSnapshot()?.[id] ?? null,
    () => null,
  )
  useEffect(() => {
    if (id && !identity) bridge?.ensure([id])
  }, [bridge, id, identity])
  return identity
}

export function isAssistantAvatar(id: string): boolean {
  return !!id && typeof window !== 'undefined'
    && (readAssistantShellBridge()?.getSnapshot()?.assistant?.id === id || readPhoneAssistantIdentity()?.id === id)
}

export function useIsAssistantAvatar(id: string): boolean {
  const bridge = typeof window === 'undefined' ? null : readAssistantShellBridge()
  const desktop = useSyncExternalStore(bridge?.subscribe ?? noopSubscribe, () => !!id && bridge?.getSnapshot()?.assistant?.id === id, () => false)
  const phone = usePhoneAssistantIdentity()
  return desktop || (!!id && phone?.id === id)
}
