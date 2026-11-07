// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useRef } from 'react'
import { createReactHarness } from '../../support/testHarness'
import { useMobileShellDiagnostics } from '../../../apps/desktop/src/mobile/useMobileListDiagnostics'
import { mobileListDiagnostics, type ShellListState } from '../../../apps/desktop/src/mobile/mobileListDiagnostics'

vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }))
const state: ShellListState = { activeTab: 'chats', pagerTab: 'chats', mobilePane: 'list', phoneLayerOpen: false, chatListHidden: false, tabBarVisible: true }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.useFakeTimers(); harness = createReactHarness(); mobileListDiagnostics.reset() })
afterEach(() => { harness.cleanup(); mobileListDiagnostics.reset(); vi.useRealTimers(); vi.unstubAllGlobals() })
function Fixture({ mobile = true, owner = 'private-account', current = state }: { mobile?: boolean; owner?: string; current?: ShellListState }) {
  const root = useRef<HTMLDivElement>(null)
  useMobileShellDiagnostics(mobile, owner, root, current)
  return <div ref={root}><div data-mobile-tab-pager><nav data-phone-root-list="chats"><button data-chat-row="private-dm">private-title</button></nav></div></div>
}

it('records settled navigation and reads the latest state on foreground return without mutating the DOM', async () => {
  await harness.render(<Fixture />)
  await act(() => vi.advanceTimersByTime(250))
  const current = { ...state, activeTab: 'contacts' as const, pagerTab: 'contacts' as const }
  await harness.render(<Fixture current={current} />)
  const before = harness.container.innerHTML
  await act(() => window.dispatchEvent(new Event('pageshow')))
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries.at(-1)).toMatchObject({ event: 'shell', reason: 'visibility', state: { activeTab: 'contacts' } })
  expect(harness.container.innerHTML).toBe(before)
  expect(JSON.stringify(mobileListDiagnostics.recent())).not.toMatch(/private-account|private-title/)
})

it('correlates a normal row click, cancels queued samples and clears evidence when the shell exits', async () => {
  await harness.render(<Fixture />)
  await act(() => harness.container.querySelector('button')!.click())
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries[0]).toMatchObject({ event: 'row-open', row: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(JSON.stringify(mobileListDiagnostics.recent())).not.toContain('private-dm')
  await harness.render(<div />)
  await act(() => { vi.advanceTimersByTime(1000); window.dispatchEvent(new Event('pageshow')) })
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries).toEqual([])
})

it('does not sample desktop shells and resets anonymous keys across accounts', async () => {
  await harness.render(<Fixture mobile={false} />)
  await act(() => { vi.advanceTimersByTime(1000); window.dispatchEvent(new Event('pageshow')) })
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries).toEqual([])
  await harness.render(<Fixture />)
  await act(() => harness.container.querySelector('button')!.click())
  await harness.render(<Fixture owner="different-private-account" />)
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries).toEqual([])
  await act(() => harness.container.querySelector('button')!.click())
  await mobileListDiagnostics.settled()
  expect(mobileListDiagnostics.recent().entries[0]).toMatchObject({ sequence: 1, row: expect.stringMatching(/^[a-f0-9]{64}$/) })
})
