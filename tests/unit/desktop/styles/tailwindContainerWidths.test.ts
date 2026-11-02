import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwind from '@tailwindcss/postcss'
import postcss, { type Root } from 'postcss'
import { beforeAll, describe, expect, it } from 'vitest'

const sizes = [
  ['xs', '20rem', '4px'],
  ['sm', '24rem', '8px'],
  ['md', '28rem', '12px'],
  ['lg', '32rem', '16px'],
  ['xl', '36rem', '20px'],
  ['2xl', '42rem', '24px'],
] as const
const widthUtilities = [
  ['w', 'width'], ['min-w', 'min-width'], ['max-w', 'max-width'], ['basis', 'flex-basis'],
  ['inline', 'inline-size'], ['min-inline', 'min-inline-size'], ['max-inline', 'max-inline-size'],
] as const
const spacingUtilities = ['h', 'min-h', 'max-h', 'size', 'block', 'min-block', 'max-block', 'p', 'm', 'gap', 'inset', 'translate-x']
const variants = ['sm:max-w-lg', 'data-[side=left]:sm:max-w-md', 'data-[side=right]:sm:max-w-xl']
let compiled: Root

function declarations(candidate: string, property: string) {
  const selector = `.${candidate.replace(/[^\w-]/g, '\\$&')}`
  const values: string[] = []
  compiled.walkRules((rule) => {
    if (rule.selector === selector) rule.walkDecls(property, (decl) => { values.push(decl.value) })
  })
  return values
}

beforeAll(async () => {
  const from = resolve('apps/desktop/src/styles/tokens.css')
  const candidates = [
    ...sizes.flatMap(([size]) => [...widthUtilities.map(([prefix]) => `${prefix}-${size}`), ...spacingUtilities.map((prefix) => `${prefix}-${size}`)]),
    ...variants, 'p-4', 'gap-3', 'p-[var(--spacing-lg)]',
  ]
  const result = await postcss([tailwind({ base: process.cwd(), optimize: false })]).process(
    `${readFileSync(from, 'utf8')}\n@source inline("${candidates.join(' ')}");`,
    { from },
  )
  compiled = postcss.parse(result.css)
})

describe('main application Tailwind container widths', () => {
  it.each(sizes)('keeps %s widths on the container scale', (size, containerWidth) => {
    for (const [prefix, property] of widthUtilities) {
      expect(declarations(`${prefix}-${size}`, property)).toEqual([`var(--container-${size})`])
    }
    const values: string[] = []
    compiled.walkDecls(`--container-${size}`, (decl) => { values.push(decl.value) })
    expect(values).toEqual([containerWidth])
  })

  it('preserves responsive and side-specific sheet/dialog container widths', () => {
    for (const candidate of variants) {
      const size = candidate.split('-').at(-1)
      expect(declarations(candidate, 'max-width')).toEqual([`var(--container-${size})`])
    }
  })

  it('keeps semantic spacing as ordinary custom properties without exporting named spacing utilities', () => {
    const selectors: string[] = []
    compiled.walkRules((rule) => { selectors.push(rule.selector) })
    for (const [size, , spacing] of sizes) {
      const values: string[] = []
      compiled.walkRules(':root', (rule) => {
        rule.walkDecls(`--spacing-${size}`, (decl) => { values.push(decl.value) })
      })
      expect(values).toEqual([spacing])
      for (const prefix of spacingUtilities) expect(selectors).not.toContain(`.${prefix}-${size}`)
    }
    expect(declarations('p-[var(--spacing-lg)]', 'padding')).toEqual(['var(--spacing-lg)'])
    expect(declarations('p-4', 'padding')).toEqual(['calc(var(--spacing) * 4)'])
    expect(declarations('gap-3', 'gap')).toEqual(['calc(var(--spacing) * 3)'])
  })
})
