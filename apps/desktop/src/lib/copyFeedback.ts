import { readMobileShell } from '@/hooks/useMobileShell'
import { notify } from './notices'

export const COPY_CONFIRMATION_MS = 1500

/** Menus disappear after copying; persistent copy buttons use their own checkmark. */
export function notifyCopied(title: string): void {
  notify({ title, tier: 'success', ...(readMobileShell() ? {
    key: 'clipboard-copy', duration: COPY_CONFIRMATION_MS, presentation: 'compact' as const,
  } : {}) })
}
