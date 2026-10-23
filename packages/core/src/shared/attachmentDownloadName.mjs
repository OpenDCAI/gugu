const encoder = new TextEncoder()
const size = value => encoder.encode(value).length
function withinBytes(value, limit) {
  let result = '', used = 0
  for (const character of value) {
    const bytes = size(character)
    if (used + bytes > limit) break
    result += character; used += bytes
  }
  return result
}

/** Portable disk name inside its hash directory; retain readable Unicode and the extension. */
export function attachmentDownloadName(value) {
  let name = value.replace(/[\\/\p{Cc}]/gu, '').replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/u, '')
  if (!name) return 'attachment'
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) name = '_' + name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? withinBytes(name.slice(dot), 60) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  return (withinBytes(stem, 200 - size(extension)).replace(/[. ]+$/u, '') || 'attachment') + extension
}
