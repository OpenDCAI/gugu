import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SearchField } from '@/components/ui/SearchField'
import { InlineNameInput } from '@/components/ui/InlineNameInput'
import { installPhoneImeDismiss } from '@/mobile/usePhoneImeDismiss'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { platform } from '@/platform'

let root: Root | undefined
let host: HTMLDivElement | undefined
let remove: (() => void) | undefined
const kind = Object.getOwnPropertyDescriptor(platform, 'kind')!
beforeEach(() => { Object.defineProperty(platform, 'kind', { configurable: true, value: 'capacitor' }) })
afterEach(() => { remove?.(); root?.unmount(); host?.remove(); Object.defineProperty(platform, 'kind', kind) })

it.each(['done', 'go', 'search'] as const)('%s preserves real browser implicit submission before dismissing the keyboard', async hint => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  remove = installPhoneImeDismiss(document)
  const submit = vi.fn()
  let focusedDuringSubmit = false
  root.render(<form onSubmit={event => { event.preventDefault(); focusedDuringSubmit = document.activeElement?.tagName === 'INPUT'; submit() }}>
    <SearchField aria-label="Search" enterKeyHint={hint} defaultValue="retained" /><button type="submit">Submit</button>
  </form>)
  await until('search mounted', () => !!host?.querySelector('input'))
  await page.getByRole('searchbox', { name: 'Search' }).click()
  await userEvent.keyboard('{Enter}')
  await until('form submitted and input blurred', () => submit.mock.calls.length === 1 && document.activeElement === document.body)
  expect(focusedDuringSubmit).toBe(true)
  expect(host.querySelector('input')!.value).toBe('retained')
})

it('does not retry a refused rename when its Enter action is followed by the IME blur', async () => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  remove = installPhoneImeDismiss(document)
  const commit = vi.fn().mockRejectedValue(new Error('Rename refused'))
  root.render(<InlineNameInput name="Old" onCommit={commit} onClose={() => {}} />)
  await page.getByRole('textbox').fill('New')
  await userEvent.keyboard('{Enter}')
  await until('rename settled and input blurred', () => document.activeElement === document.body)
  expect(commit).toHaveBeenCalledTimes(1)
})
