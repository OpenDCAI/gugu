import { i18n } from '@/i18n'
import { platform } from '@/platform'
import { notify } from '@/lib/notices'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'

/** Copy controls report a refusal before their success-state handler observes the rejection. */
export async function copyTextWithFeedback(text: string): Promise<void> {
  try {
    await platform.writeClipboardText(text)
  } catch (error) {
    notify({ tier: 'error', title: i18n.t('actions.copyFailed', { ns: 'common' }), description: safeFailureLine(String((error as Error)?.message ?? error)) })
    throw error
  }
}
