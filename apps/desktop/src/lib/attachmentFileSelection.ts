export const MOBILE_ATTACHMENT_LIMIT = 10
export type SelectedAttachmentFile = { id: string; file: File }

/** Reserve before async preview/upload work, so consecutive pick/paste/drop events share capacity. */
export function createAttachmentFileSelection(onLimit: () => void) {
  let visible = new Set<string>()
  const pending = new Map<string, File>()
  return {
    observe(attachments: readonly { id: string; file?: File }[]) {
      // Some adapters allocate their own IDs. Reconcile newly arrived files one at a time.
      for (const attachment of attachments) {
        if (pending.has(attachment.id)) pending.delete(attachment.id)
        else if (!visible.has(attachment.id) && attachment.file) {
          const reservation = [...pending].find(([, file]) => file === attachment.file)
          if (reservation) pending.delete(reservation[0])
        }
      }
      visible = new Set(attachments.map(attachment => attachment.id))
    },
    choose(files: readonly File[], mobile: boolean): SelectedAttachmentFile[] {
      const capacity = mobile ? Math.max(0, MOBILE_ATTACHMENT_LIMIT - visible.size - pending.size) : files.length
      if (files.length > capacity) onLimit()
      return files.slice(0, capacity).map(file => {
        const id = crypto.randomUUID()
        pending.set(id, file)
        return { id, file }
      })
    },
    release(files: readonly SelectedAttachmentFile[]) {
      for (const { id } of files) pending.delete(id)
    },
  }
}
