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
