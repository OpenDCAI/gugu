import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwind from '@tailwindcss/postcss'
import postcss, { type AcceptedPlugin, type Root, type Node, type Rule } from 'postcss'
import { beforeAll, expect, it } from 'vitest'

const entries = ['apps/desktop/src/styles/tokens.css', 'apps/desktop/src/session/renderer/index.css']
const compiled: Root[] = []
beforeAll(async () => {
  for (const entry of entries) {
    const from = resolve(entry)
    const result = await postcss([tailwind({ base: process.cwd(), optimize: false }) as unknown as AcceptedPlugin]).process(readFileSync(from, 'utf8'), { from })
    compiled.push(postcss.parse(result.css))
  }
})
function layers(node: Node): string[] {
  const chain: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name === 'layer') chain.unshift(parent.params)
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
    const rule = decl.parent as Rule
    expect(rule.selector).toContain('::before')
    expect(rule.selector).toContain('::backdrop')
    expect(rule.selector).toContain('::file-selector-button')
    expect(rule.nodes.filter(node => node.type === 'decl')).toHaveLength(1)
  })
  expect(found).toBe(1)
})
