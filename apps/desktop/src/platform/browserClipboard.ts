/** The browser clipboard transport is only reached by the platform adapters. */
export async function writeBrowserClipboardText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}
