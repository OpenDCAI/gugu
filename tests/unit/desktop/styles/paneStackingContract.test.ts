import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')
const css = read('apps/desktop/src/styles/tokens.css')
const layer = read('apps/desktop/src/session/renderer/features/extensions/extension-view-layer.tsx')
const pane = read('apps/desktop/src/session/renderer/features/tabs/pane-content.tsx')
const menu = read('packages/session-ui/src/react/primitives/dropdown-menu/dropdown-menu.css.ts')

describe('workspace surfaces share one stacking contract', () => {
  it('puts ordinary guests below dividers and fullscreen, and only fullscreen guests above the opaque pane', () => {
    const order = ['pane-resident', 'pane-divider', 'pane-fullscreen', 'pane-fullscreen-resident', 'menu']
    const levels = order.map((role) => {
      const declarations = [...css.matchAll(new RegExp(`--z-${role}:\\s*(\\d+)\\s*;`, 'g'))]
      expect(declarations, role).toHaveLength(1)
      return Number(declarations[0]![1])
    })
    for (let i = 1; i < levels.length; i++) expect(levels[i - 1]).toBeLessThan(levels[i]!)
  })

  it('keeps the resident measurement container out of a fixed or numeric stacking context', () => {
    const classes = /data-slot="extension-view-layer"\s+className="([^"]+)"/.exec(layer)?.[1]?.split(/\s+/)
    expect(classes).toContain('absolute')
    expect(classes).not.toContain('fixed')
    expect(classes?.some((name) => /^z-/.test(name))).toBe(false)
    expect(layer).toContain("ancestorsOf(claim.element).some((element) => element.hasAttribute('data-tab-fullscreen'))")
    expect(layer).toContain("'var(--z-pane-fullscreen-resident)'")
    expect(layer).toContain("'var(--z-pane-resident)'")
  })

  it('prevents the pane, divider and menu from choosing independent numeric levels', () => {
    expect(pane).toContain("zIndex: 'var(--z-pane-fullscreen)'")
    expect(pane).toContain("zIndex: 'var(--z-pane-divider)'")
    const divider = pane.slice(pane.indexOf('const PairDivider'))
    expect(divider).not.toMatch(/\bz-\d+\b/)
    const menuLevels = [...menu.matchAll(/zIndex:\s*([^,\n]+)/g)].map((match) => match[1])
    expect(menuLevels).not.toHaveLength(0)
    expect(menuLevels.every((value) => value === "'var(--z-menu)'")).toBe(true)
  })
})
