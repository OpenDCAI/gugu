import { describe, expect, it } from 'vitest'
import { classifyFileLink, groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/fileLink'

/**
 * 摩擦单 F10 / F112: `gugu-file://<itemId>` — how the MCP tools and `gugu.send` name a file of a group or topic. Only the
 * file: which chat it is in is read from it when it opens. One reading of it for every place that takes one: a chat
 * link, a task transcript link, `session_open_in_tab`.
 */
const CHAT = '44444444-4444-4444-8444-444444444444'
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
/** A chat bubble's href as the Markdown renderer writes it: what is not ASCII percent-encoded, every %XX left as it is. */
const rendered = (link: string) => link.replace(/[^ -~]/gu, (c) => encodeURIComponent(c))

describe('gugu-file links (F10, F112)', () => {
  it('reads the item, whatever the case and a trailing slash or spaces', () => {
    expect(parseGroupFileLink(`gugu-file://${ITEM}`)).toEqual({ itemId: ITEM })
    expect(parseGroupFileLink(` GUGU-FILE://${ITEM.toUpperCase()}/ `)).toEqual({ itemId: ITEM })
  })

  it('is not a link to a group file unless its path is the item id alone — the two-id form of before included', () => {
    // F112: the form with the chat in it was the one an agent got wrong; it is not read at all (never released).
    expect(parseGroupFileLink(`gugu-file://${CHAT}/${ITEM}`)).toBeNull()
    expect(parseGroupFileLink(`gugu-file://${ITEM}/more`)).toBeNull()
    expect(parseGroupFileLink('gugu-file://not-an-item')).toBeNull()
    expect(parseGroupFileLink(`https://${ITEM}`)).toBeNull()
  })

  it('classifies it before paths and web links: a group file, never a local path or an external page', () => {
    expect(classifyFileLink(`gugu-file://${ITEM}`)).toEqual({ kind: 'group-file', itemId: ITEM })
    // Controls: the other kinds read as before.
    expect(classifyFileLink('gugu-file://broken')).toEqual({ kind: 'external' })
    expect(classifyFileLink('notes/a.md')).toEqual({ kind: 'workspace-file', path: 'notes/a.md' })
    expect(classifyFileLink('https://example.com')).toEqual({ kind: 'external' })
  })
})

// App 引用 pill (owner 10-14, 148 17:03): the version a place was picked on and the place itself ride in the link, so every
// reader of it — a chat link, a pill, session_open_in_tab — has them, not only the one that draws the pill.
describe('a pill’s link: the file, the version it was picked on, the place in it', () => {
  it('reads ?v= and #k=v&k=v beside the item, the place as keys and values; either may be missing', () => {
    expect(parseGroupFileLink(`gugu-file://${ITEM}?v=7#slide=3&shape=12`)).toEqual({ itemId: ITEM, version: 7, at: { slide: '3', shape: '12' } })
    expect(parseGroupFileLink(`gugu-file://${ITEM}?v=3`)).toEqual({ itemId: ITEM, version: 3 })
    expect(parseGroupFileLink(`gugu-file://${ITEM}#range=销售!B2:D4`)).toEqual({ itemId: ITEM, at: { range: '销售!B2:D4' } })
    expect(classifyFileLink(`gugu-file://${ITEM}?v=2#range='2024%20预算'!A1:D4`)).toEqual({
      kind: 'group-file', itemId: ITEM, version: 2, at: { range: "'2024 预算'!A1:D4" },
    })
  })

  // 155 10-15: dev to 0.2.54 anchored the whole link, so a link with anything after the id was no link at all there. This
  // reader reads what it knows and lets the rest be.
  it('lets be what it does not know: another query parameter, a `v` that is not a whole number, an empty place', () => {
    expect(parseGroupFileLink(`gugu-file://${ITEM}?x=1`)).toEqual({ itemId: ITEM })
    expect(parseGroupFileLink(`gugu-file://${ITEM}?x=1&v=4&y`)).toEqual({ itemId: ITEM, version: 4 })
    expect(parseGroupFileLink(`gugu-file://${ITEM}?v=next#slide=1`)).toEqual({ itemId: ITEM, at: { slide: '1' } })
    expect(parseGroupFileLink(`gugu-file://${ITEM}#`)).toEqual({ itemId: ITEM })
    // Control: the path stays the file's alone — a second id is not read as this one (F112's two-id form).
    expect(parseGroupFileLink(`gugu-file://${ITEM}/more?v=1`)).toBeNull()
  })

  // 155 10-15: the place is the App's keys and values; gugu writes them and reads them back — the App escapes nothing.
  it('writes it one way, each key and value escaped, and reads back exactly what the App named — from the text and a bubble’s href', () => {
    expect(groupFileLink(ITEM)).toBe(`gugu-file://${ITEM}`)
    expect(groupFileLink(ITEM, { version: 7, at: { slide: 3, shape: '12', k: 1 } })).toBe(`gugu-file://${ITEM}?v=7#slide=3&shape=12&k=1`)
    // What an agent reads stays near as written: Chinese, `!`, `:` bare; a sheet's own `&` escaped.
    expect(groupFileLink(ITEM, { at: { range: '销售!B2:D4' } })).toBe(`gugu-file://${ITEM}#range=销售!B2:D4`)
    expect(groupFileLink(ITEM, { at: { range: 'R&D!A1' } })).toBe(`gugu-file://${ITEM}#range=R%26D!A1`)
    // `+` too: a form decoder (URLSearchParams) would read a bare one as a space (复核 156f72cb0e).
    const plus = groupFileLink(ITEM, { at: { range: "'Q1+Q2'!B3" } })
    expect(plus).toBe(`gugu-file://${ITEM}#range='Q1%2BQ2'!B3`)
    expect(parseGroupFileLink(plus)!.at).toEqual({ range: "'Q1+Q2'!B3" })
    expect(new URLSearchParams(plus.split('#')[1]).get('range')).toBe("'Q1+Q2'!B3")
    const places: Record<string, string>[] = [
      { range: 'R&D!A1', note: 'a=b 100%' },
      { range: "'2024 预算'!A1:D4" },
      { t: '&lt;x', u: 'x;y', h: 'a#b' },
      { entry: 'a<b>c', note: 'a\\b', line: 'a\nb', tab: '\t"`|' },
      { x: '(1)[2]{3}', q: '%E7%94%B2', empty: '' },
      { 'key with space': 'v', 'k&=': '1' },
      // An object the App read from JSON may hold a key named `__proto__` of its own.
      JSON.parse('{"__proto__":"x","slide":"2"}') as Record<string, string>,
    ]
    for (const at of places) {
      const link = groupFileLink(ITEM, { version: 1, at })
      expect(link, JSON.stringify(at)).not.toMatch(/[\s<>\\()[\]{}"`|;]/)
      expect(parseGroupFileLink(link)!.at, JSON.stringify(at)).toEqual(at)
      // A chat bubble's href: the Markdown renderer percent-encodes what the text left bare (Chinese), keeping each %XX it
      // finds (micromark normalizeUri); read the same.
      expect(parseGroupFileLink(rendered(link))!.at, JSON.stringify(at)).toEqual(at)
    }
    // A link written by hand with a bare `%`: the value as it stands, not lost.
    expect(parseGroupFileLink(`gugu-file://${ITEM}#note=100%`)!.at).toEqual({ note: '100%' })
  })
})

describe('a working-copy link’s place: `path#k=v&k=v` or a line, read in this one place', () => {
  it('splits a place or a line off the path, the place as a group file link carries it', () => {
    expect(classifyFileLink('论文/Attention.pdf#page=4&h=dc61c666d06d')).toEqual({ kind: 'workspace-file', path: '论文/Attention.pdf', at: { page: '4', h: 'dc61c666d06d' } })
    expect(classifyFileLink('src/a.ts#L10')).toEqual({ kind: 'workspace-file', path: 'src/a.ts', at: { L10: '' } })
    expect(classifyFileLink('src/a.ts#L10-L20')).toEqual({ kind: 'workspace-file', path: 'src/a.ts', at: { 'L10-L20': '' } })
    expect(classifyFileLink('/Users/me/p/a.pdf#page=2')).toEqual({ kind: 'workspace-file', path: '/Users/me/p/a.pdf', at: { page: '2' } })
    expect(classifyFileLink('C:/p/a.pdf#page=2')).toEqual({ kind: 'workspace-file', path: 'C:/p/a.pdf', at: { page: '2' } })
    // A bubble's href: percent-encoded by the renderer, the place's values decoded once, as a group file's.
    expect(classifyFileLink('%E8%AE%BA%E6%96%87/a.pdf#q=%E7%94%B2')).toEqual({ kind: 'workspace-file', path: '论文/a.pdf', at: { q: '甲' } })
  })

  it('leaves a name with a # of its own as the name — only a fragment that reads as a place or a line is one', () => {
    for (const name of ['issue#12.md', 'C#笔记.md', 'notes/#todo.md', 'a#b', 'x#L10a.ts', 'a#k=v/b.pdf', 'a#k=v&b']) {
      expect(classifyFileLink(name), name).toEqual({ kind: 'workspace-file', path: name })
    }
    // Only the last `#` can start the place: a folder with a # in its name keeps it.
    expect(classifyFileLink('a#1/b.pdf#page=3')).toEqual({ kind: 'workspace-file', path: 'a#1/b.pdf', at: { page: '3' } })
    // A name whose own `#…` would read as a place is linked with that `#` escaped, and read back as `#`.
    expect(classifyFileLink('v%23k=1.md')).toEqual({ kind: 'workspace-file', path: 'v#k=1.md' })
  })

  it('keeps web links and in-page anchors what they were', () => {
    expect(classifyFileLink('https://example.com/a#page=2')).toEqual({ kind: 'external' })
    expect(classifyFileLink('#page=2')).toEqual({ kind: 'external' })
  })
})
