export const SOURCE_MESSAGE_FLASH_MS = 1400

/** Shared by chat and session references: reveal the exact anchor, then flash it. */
export async function revealSourceMessage(messageId: string, input: {
  showLoaded: (id: string) => boolean
  load: (id: string) => Promise<void>
  flash: (id: string) => void
  missing: () => void
  current: () => boolean
}): Promise<void> {
  try {
    if (!input.showLoaded(messageId)) await input.load(messageId)
    if (input.current()) input.flash(messageId)
  } catch {
    if (input.current()) input.missing()
  }
}
