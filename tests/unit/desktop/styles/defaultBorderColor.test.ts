import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import tailwind from '@tailwindcss/postcss'
import postcss, { type AcceptedPlugin, type AtRule, type Root, type Node, type Rule } from 'postcss'
import { beforeAll, expect, it } from 'vitest'
import { rendererHtmlEntries } from '../../../../scripts/build/product-build-entries.mts'

const entries = ['apps/desktop/src/styles/tokens.css', 'apps/desktop/src/session/renderer/index.css']
const compiled: Root[] = []
beforeAll(async () => {
  for (const entry of entries) {
    const from = resolve(entry)
    const result = await postcss([tailwind({ base: process.cwd(), optimize: false }) as unknown as AcceptedPlugin]).process(readFileSync(from, 'utf8'), { from })
    compiled.push(postcss.parse(result.css))
  }
})
function isAtRule(node: Node): node is AtRule {
  return node.type === 'atrule'
}
function isRule(node: Node): node is Rule {
  return node.type === 'rule'
}
function layers(node: Node): string[] {
  const chain: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isAtRule(parent) && parent.name === 'layer') chain.unshift(parent.params)
  }
  return chain
}
it.each([0, 1])('keeps entry %i Preflight below ordinary base rules', index => {
  let found = 0
  compiled[index].walkDecls('border', decl => {
    if (decl.value !== '0 solid') return
    found++
    expect(layers(decl).join('.')).toBe('base.preflight')
  })
  expect(found).toBeGreaterThan(0)
})
it.each([0, 1])('gives entry %i a color-only semantic base default', index => {
  let found = 0
  compiled[index].walkDecls('border-color', decl => {
    if (decl.value !== 'var(--border-color, var(--border, currentColor))') return
    found++
    expect(layers(decl)).toEqual(['base'])
    const rule = decl.parent
    if (!rule || !isRule(rule)) throw new Error('The semantic border default must belong to a CSS rule')
    expect(rule.selector).toContain('::before')
    expect(rule.selector).toContain('::backdrop')
    expect(rule.selector).toContain('::file-selector-button')
    expect(rule.nodes.filter(node => node.type === 'decl')).toHaveLength(1)
  })
  expect(found).toBe(1)
})
// @@@has-universal-descendant — `group-has-*` compiles to `:has(...) *`: a change the browser cannot
// scope re-styles the whole page, and one such rule cost every message-bubble hover about 240 ms.
const hasThenUniversal = /:has\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)[^,]*?(?:(?<![>+\s])\s+\*|~\s*\*)/
function flatSelector(rule: Rule): string {
  const chain = [rule.selector]
  for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
    if (isRule(parent)) chain.unshift(parent.selector)
  }
  return chain.join(' ')
}
it.each([0, 1])('keeps entry %i free of :has() followed by a universal descendant', index => {
  expect(hasThenUniversal.test(':is(:where(.group\\/field):has(:disabled) *)')).toBe(true)
  const hits: string[] = []
  compiled[index].walkRules(rule => {
    if (hasThenUniversal.test(flatSelector(rule))) hits.push(flatSelector(rule))
  })
  expect(hits).toEqual([])
})
// Portals append to <body>; if #root could flip :last-child, the first portal would restyle the whole app.
it.each(Object.values(rendererHtmlEntries))('keeps a fixed element after #root in %s', entry => {
  const body = readFileSync(entry, 'utf8').replace(/<!--.*?-->/gs, '')
  expect(body).toMatch(/<div id="root"><\/div>\s*<div data-root-sibling hidden><\/div>/)
})
// @@@tag-only-sibling — `li + li` keys the sibling check on a bare tag, so a tooltip leaving <body> restyled
// every div/span/li under #root (12.6k elements, ~90 ms) on the first move into the message list. Key it on
// `:not(:first-child)` instead.
const tagThenAdjacent = /(?:^|[\s>+~(,])[a-z][a-z0-9-]*\s*\+(?!\s*\d)/
const sourceCss = ['apps/desktop/src', 'packages'].flatMap(dir =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css') && !file.includes('node_modules')).map(file => join(dir, file)))
it('keeps every source stylesheet free of sibling rules keyed only by a tag', () => {
  expect(tagThenAdjacent.test('.gg-md li + li')).toBe(true)
  expect(tagThenAdjacent.test(':nth-child(2n+1)')).toBe(false)
  expect(sourceCss).toContain(join('packages', 'session-shared/src/markdown/markdown.css'))
  const hits: string[] = []
  for (const file of sourceCss) {
    postcss.parse(readFileSync(file, 'utf8')).walkRules(rule => {
      if (tagThenAdjacent.test(flatSelector(rule))) hits.push(`${file}: ${flatSelector(rule)}`)
    })
  }
  expect(hits).toEqual([])
})
