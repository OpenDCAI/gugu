// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import postcss, { type Declaration, type Rule } from 'postcss'
import { afterEach, describe, expect, it } from 'vitest'
import { hasWindowTitlebarRow } from '../../../../apps/desktop/src/lib/window-chrome'

const css = postcss.parse(readFileSync('apps/desktop/src/styles/tokens.css', 'utf8'))
const selector = ":root[data-window-titlebar='row'][data-window-material='opaque'] [data-gugu-shell-phase] > .gg-sidebar-rail + div"

function boundaryRule() {
  const rules: Rule[] = []
  css.walkRules(selector, (rule) => { rules.push(rule) })
  expect(rules, 'the window boundary must have one geometry owner').toHaveLength(1)
  return rules[0]!
}

function content(platform: string, material: 'native' | 'opaque') {
  document.documentElement.dataset.windowMaterial = material
  if (hasWindowTitlebarRow(platform)) document.documentElement.dataset.windowTitlebar = 'row'
  document.body.innerHTML = '<div data-gugu-shell-phase="active"><aside class="gg-sidebar-rail"></aside><div data-content></div></div>'
  return document.querySelector('[data-content]')!
}

afterEach(() => {
  delete document.documentElement.dataset.windowTitlebar
  delete document.documentElement.dataset.windowMaterial
  document.body.replaceChildren()
})

describe('opaque caption-row content boundary', () => {
  it('keeps the transparent borders and shared corner together without a second visible frame', () => {
    const rule = boundaryRule()
    expect(content('win', 'opaque').matches(rule.selector)).toBe(true)
    const declarations = new Map<string, Declaration>()
    rule.walkDecls((declaration) => { declarations.set(declaration.prop, declaration) })
    expect(declarations.get('border-top')?.value).toBe('1px solid transparent')
    expect(declarations.get('border-left')?.value).toBe('1px solid transparent')
    expect(declarations.get('border-top-left-radius')?.value).toBe('var(--radius-surface)')
    expect(declarations.get('border-top-left-radius')?.important).toBe(true)
    expect(declarations.has('box-shadow')).toBe(false)
  })

  it.each([
    ['mac', 'native'],
    ['mac', 'opaque'],
    ['linux', 'opaque'],
    ['other', 'opaque'],
    ['win', 'native'],
  ] as const)('does not change %s / %s window geometry', (platform, material) => {
    expect(content(platform, material).matches(boundaryRule().selector)).toBe(false)
  })
})
