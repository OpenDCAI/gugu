/**
 * What a rendered piece of UI says and the hooks other code keys on (data-*, title, role, aria-label) —
 * not its class names, inline styles or icon paths. For snapshot-style checks that a reviewer can read and
 * that a restyle does not invalidate.
 */
export function domFace(root: Element): { text: string[]; marks: string[] } {
  const kept = (name: string) => name.startsWith('data-') || name === 'title' || name === 'role' || name === 'aria-label' || name === 'disabled'
  const marks = [...root.querySelectorAll('*')].flatMap((el) => {
    const attrs = [...el.attributes].filter((attr) => kept(attr.name)).map((attr) => `${attr.name}=${attr.value}`)
    return attrs.length ? [`${el.tagName.toLowerCase()} ${attrs.join(' ')}`] : []
  })
  const text: string[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('svg')) continue
    const value = node.textContent?.trim()
    if (value) text.push(value)
  }
  return { text, marks }
}
