/** Hermes joins ACP text blocks. Only these complete leading host notices may precede the original user text. */
export function stripNativePromptNotices(text: string): string {
  let source = text.trim()
  for (;;) {
    const opening = /^<(resource_changes|gugu_profile_review)>/.exec(source)
    if (!opening) return source
    const closing = `</${opening[1]}>`
    const end = source.indexOf(closing, opening[0].length)
    if (end < 0) return source
    source = source.slice(end + closing.length).trimStart()
  }
}
