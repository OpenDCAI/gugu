import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { parseGuguLink, type GuguLinkTarget, type LinkPlace } from '@gugu/core/shared/ui/guguLink'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { platform } from '../platform'
import { notify } from './notices'
import { readMobileShell } from '../hooks/useMobileShell'

/** One shell request for a resolved target, shared by the main and session renderer roots. */
export const OPEN_LINK_TARGET = 'gugu:open-link-target'
export type LinkNavigation = {
  target: GuguLinkTarget
  message?: MessageItem
  restore?: () => void
  resolve(opened?: LinkPlace | 'own'): void
  reject(error: unknown): void
}

export function openLinkTarget(target: GuguLinkTarget, source: Pick<LinkNavigation, 'message' | 'restore'> = {}): Promise<LinkPlace | 'own' | void> {
  return new Promise((resolve, reject) => {
    const detail: LinkNavigation = { target, ...source, resolve, reject }
    if (window.dispatchEvent(new CustomEvent(OPEN_LINK_TARGET, { detail, cancelable: true }))) reject(new Error('The chat shell is not ready to open this link'))
  })
}

/** A click is parsed once here; main receives the target, not a URL to parse a second time. */
export function openLink(raw: string | GuguLinkTarget): Promise<boolean> | null {
  const target = typeof raw === 'string' ? parseGuguLink(raw, { supabaseUrl: readMobileShell() ? getSupabaseUrl() : undefined }) : raw
  if (!target) return null
  return openTarget(target)
}

export async function openTarget(target: GuguLinkTarget): Promise<boolean> {
  const outcome = platform.kind === 'electron'
    ? await (await import('../session/renderer/lib/ipc')).rpc.extensions.openLink({ target })
    : await (await import('../components/appSlot/phoneAppHost')).openPhoneLink(target)
  if (outcome.kind === 'not-gugu-link') return false
  if (outcome.kind === 'failed') throw new Error(`${outcome.name}: ${outcome.detail ?? outcome.reason}`)
  return true
}

/** DOM callers claim synchronously; the one promise reports a failure through the existing notice host. */
export function followLink(raw: string | GuguLinkTarget): boolean {
  const opened = openLink(raw)
  if (!opened) return false
  void opened.catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
  return true
}
