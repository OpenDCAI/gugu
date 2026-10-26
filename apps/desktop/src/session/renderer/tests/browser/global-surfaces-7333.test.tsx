import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { contact, createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import { ActionButton, FieldList, FieldRow } from '@/components/contactsDetailControls'
import { AliasSheet } from '@/components/contacts/AliasSheet'
import { ContactsSectionState } from '@/components/contacts/ContactsSectionState'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { ShellErrorBoundary } from '@/components/ShellErrorBoundary'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { i18n } from '@/i18n'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))

let harness: ReturnType<typeof createReactHarness>
beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
beforeEach(async () => { await page.viewport(1080, 900) })
afterEach(() => {
  harness?.cleanup()
  document.documentElement.removeAttribute('data-theme')
})
function mount() {
  harness = createReactHarness()
  return harness
}
function tier(element: Element | null) {
  expect(element, 'the measured text must exist').not.toBeNull()
  const style = getComputedStyle(element!)
  return { size: Number.parseFloat(style.fontSize), leading: Math.round(Number.parseFloat(style.lineHeight)) }
}
function byText(text: string) {
  return [...document.querySelectorAll<HTMLElement>('div, span')].filter((element) => element.textContent === text).at(-1) ?? null
}
function token(name: string) {
  const probe = document.createElement('i')
  probe.style.cssText = `position:absolute;color:var(${name})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

describe('remaining contact and error surfaces consume the master (#7333)', () => {
  it.each(['light', 'dark'])('contact actions use the shared primary in %s, preserve activation and disabled behavior', async (theme) => {
    document.documentElement.dataset.theme = theme
    const onClick = vi.fn()
    await mount().render(<><ActionButton icon={null} label="发消息" primary onClick={onClick} /><ActionButton icon={null} label="暂不可用" disabled onClick={onClick} /></>)
    const primary = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '发消息')!
    expect(primary).not.toBeNull()
    expect(tier(primary)).toEqual({ size: 14, leading: 20 })
    expect(getComputedStyle(primary).backgroundColor).toBe(token('--primary'))
    expect(getComputedStyle(primary).color).toBe(token('--primary-fg'))
    expect(getComputedStyle(primary).borderRadius).toBe('8px')
    expect(primary.getBoundingClientRect().height).toBeGreaterThanOrEqual(36)
    await userEvent.hover(primary)
    await untilStable('the contact action hover settles', () => getComputedStyle(primary).opacity)
    expect(Number(getComputedStyle(primary).opacity)).toBe(0.88)
    await userEvent.click(primary)
    expect(onClick).toHaveBeenCalledTimes(1)
    const disabled = harness.container.querySelector<HTMLButtonElement>('button:disabled')!
    expect(disabled).not.toBeNull()
    disabled.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('contact fields and loading/empty notices read compact 14/20', async () => {
    await renderWithAppProviders(mount(), <><FieldList><FieldRow label="咕咕号" value="123456" /></FieldList><ContactsSectionState status="ready" isEmpty emptyLabel="暂无联系人" /></>)
    const cells = harness.container.querySelectorAll('[data-field-cell]')
    expect(cells).toHaveLength(2)
    for (const cell of cells) expect(tier(cell)).toEqual({ size: 14, leading: 20 })
    expect(tier(byText('暂无联系人'))).toEqual({ size: 14, leading: 20 })
  })

  it('the real alias sheet has 16/24 title and 14/20 input, and still saves the typed alias', async () => {
    const updateContactAlias = vi.fn<(id: string, alias: string) => Promise<void>>(async () => {})
    const onClose = vi.fn()
    const person = contact({ id: 'alias-person', display_name: '林知夏', alias: '原备注' })
    await renderWithAppProviders(mount(), <AliasSheet name={person.display_name} alias={person.alias} seed={person.id} onSave={(alias) => updateContactAlias(person.id, alias)} onClose={onClose} />, { contacts: { updateContactAlias } })
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${AUTOMATION_TEST_IDS.contactAliasSheetInput}"]`)!
    expect(input).not.toBeNull()
    expect(tier(byText('林知夏'))).toEqual({ size: 16, leading: 24 })
    expect(tier(input)).toEqual({ size: 14, leading: 20 })
    expect(getComputedStyle(input).borderRadius).toBe('8px')
    await untilStable('the sheet finishes scaling the input', () => Math.round(input.getBoundingClientRect().height * 100) / 100)
    const inputStyle = getComputedStyle(input)
    expect(input.getBoundingClientRect().height, JSON.stringify({ viewport: innerWidth, height: inputStyle.height, minHeight: inputStyle.minHeight, padding: inputStyle.padding, boxSizing: inputStyle.boxSizing, xl: inputStyle.getPropertyValue('--control-h-xl') })).toBeCloseTo(40, 1)
    await userEvent.fill(input, '  周末搭子  ')
    await page.getByTestId(AUTOMATION_TEST_IDS.contactAliasSheetSave).click()
    await until('the alias save completes', () => onClose.mock.calls.length === 1)
    expect(updateContactAlias).toHaveBeenCalledWith(person.id, '周末搭子')
  })

  it.each(['app', 'shell'])('%s failure keeps its recovery actions while using title/body/code roles', async (kind) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function Broken(): never { throw new Error('layout evidence: a real render failure') }
    const boundary = kind === 'app' ? AppErrorBoundary : ShellErrorBoundary
    await renderWithAppProviders(mount(), createNode(boundary, null, <Broken />))
    const text = i18n.t(kind === 'app' ? 'errorBoundary.title' : 'errorBoundary.shell.title', { ns: 'main' })
    expect(text).not.toBe(kind === 'app' ? 'errorBoundary.title' : 'errorBoundary.shell.title')
    expect(tier(byText(text))).toEqual({ size: 16, leading: 24 })
    const description = i18n.t(kind === 'app' ? 'errorBoundary.description' : 'errorBoundary.shell.description', { ns: 'main' })
    expect(tier(byText(description))).toEqual({ size: 14, leading: 20 })
    const details = harness.container.querySelector('details')!
    expect(details).not.toBeNull()
    await userEvent.click(details.querySelector('summary')!)
    const code = details.querySelector('pre')!
    expect(tier(code)).toEqual({ size: 13, leading: 20 })
    expect(getComputedStyle(code).fontFamily).toContain('JetBrains Mono')
    expect(code.textContent).toContain('layout evidence: a real render failure')
    const reloadLabel = i18n.t(kind === 'app' ? 'errorBoundary.reload' : 'errorBoundary.shell.reload', { ns: 'main' })
    const reload = [...harness.container.querySelectorAll('button')].find((button) => button.textContent === reloadLabel)!
    expect(reload).not.toBeNull()
    const primary = kind === 'app' ? reload : harness.container.querySelector<HTMLButtonElement>('[data-variant="primary"]')!
    expect(primary).not.toBeNull()
    await untilStable('the recovery button settles', () => getComputedStyle(primary).color)
    expect(getComputedStyle(primary).color).toBe(token('--primary-fg'))
  })
})
