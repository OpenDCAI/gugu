// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { MessageHoverRegion } from '../../../../apps/desktop/src/components/chat/HoverActionBar'
import { claimHoverOwner, releaseHoverOwner } from '../../../../apps/desktop/src/components/chat/hover-owner'

/**
 * 气泡上的悬浮操作条任何时刻最多一个(owner 10-28:划过时偶尔同时出现两个)。
 * 实机复现的两种:换行时新旧叠约 200ms(各自的 close delay);一行的「更多」开着时再悬到别的行。
 */
describe('message hover bar: one row owns it at a time', () => {
  const a = Symbol('a')
  const b = Symbol('b')
  afterEach(() => {
    releaseHoverOwner(a)
    releaseHoverOwner(b)
  })

  it('the row that opens takes it over from the row before, at once', () => {
    expect(claimHoverOwner(a)).toBe(true)
    expect(claimHoverOwner(b)).toBe(true)
    // a lost it: claiming again is a fresh hand-over, not a second bar.
    expect(claimHoverOwner(a)).toBe(true)
  })

  it('a row whose menu is open (forceOpen) keeps it; another row cannot take it until the menu closes', () => {
    expect(claimHoverOwner(a, true)).toBe(true)
    expect(claimHoverOwner(b)).toBe(false)
    releaseHoverOwner(b) // not the owner: no effect
    expect(claimHoverOwner(b)).toBe(false)
    releaseHoverOwner(a)
    expect(claimHoverOwner(b)).toBe(true)
  })
})

describe('MessageHoverRegion renders at most one visible bar', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())

  const Row = ({ name, forceOpen }: { name: string; forceOpen: boolean }) => (
    <MessageHoverRegion enabled forceOpen={forceOpen} style={{}} actions={<span data-bar={name} />}>{null}</MessageHoverRegion>
  )
  const bars = () => [...harness.container.querySelectorAll('[data-bar]')].map((node) => node.getAttribute('data-bar'))

  it('two rows asking to stay open (menus) show one bar, the first; it moves only when that menu closes', async () => {
    await harness.render(<><Row name="a" forceOpen /><Row name="b" forceOpen={false} /></>)
    expect(bars()).toEqual(['a'])
    await harness.render(<><Row name="a" forceOpen /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['a'])
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['b'])
    // And it settles: re-rendering the same tree does not keep handing the bar around.
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['b'])
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen={false} /></>)
    expect(bars()).toEqual([])
  })
})
