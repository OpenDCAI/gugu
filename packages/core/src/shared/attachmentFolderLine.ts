import { attachmentEnvelope } from './ui/attachmentModels'
import { groupFileLink } from './ui/guguLink'

/**
 * What an agent reads about an attachment that is a file of its chat's folder — in a delivery, message_history and
 * message_download_file alike: which file and version it is, and how to send it again or send a changed one, so a
 * change becomes that file's next version and never a new copy.
 */
export function attachmentFolderLine(itemId: string, version: number): string {
  const file = groupFileLink(itemId, { version })
  return `[Folder file ${file} — show it again: message_send_file {file: "${file}"}; changed it: message_send_file {file: "${file}", file_path} sends your copy as its next version, never as a new attachment]`
}

/**
 * The lines after an attachment's head that say where the agent's copy is: the folder file, then its local path — or why
 * there is none. One format for an attachment message delivered from a chat and a task turn's attachment (P3): an agent
 * cannot tell which door a file came through. `saved` null: nothing to save (the item is gone, or an old URL attachment).
 */
export function attachmentLocationLines(item: { itemId: string; version: number } | null, image: boolean,
  saved: { localPath: string } | { failure: string } | null): string {
  const folder = item ? `\n${attachmentFolderLine(item.itemId, item.version)}` : ''
  if (!saved) return folder
  if ('failure' in saved) return `${folder}\n[${image ? 'Image' : 'File'} not saved: ${saved.failure}]`
  return `${folder}\n[${image ? 'Image attached at' : 'File saved at'} local path: ${saved.localPath}]`
}

/** A task turn's attachment as its agent reads it (P3) — head, folder file and local path, as a delivered attachment reads. */
export function turnAttachmentText(file: { itemId: string; version: number; name: string; mimeType: string; sizeBytes: number },
  saved: { localPath: string } | { failure: string }): string {
  const image = file.mimeType.startsWith('image/')
  const head = image ? `[Image attached: ${file.name}]` : attachmentEnvelope(file.name, file.sizeBytes, file.mimeType)
  return `${head}${attachmentLocationLines({ itemId: file.itemId, version: file.version }, image, saved)}`
}
