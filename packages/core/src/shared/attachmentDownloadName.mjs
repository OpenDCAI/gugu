/** Keep the original display name inside its content-hash directory, without path or control characters. */
export function attachmentDownloadName(value) {
  const name = value.replace(/[\\/\p{Cc}]/gu, '')
  return !name || name === '.' || name === '..' ? 'attachment' : name
}
