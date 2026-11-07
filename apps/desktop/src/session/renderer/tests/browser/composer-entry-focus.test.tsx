import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { requestComposerEntryFocus } from '@/lib/composerEntryFocus'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = host = null; requestComposerEntryFocus(null) })
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

async function mount(active = true, mobile = false, surface: 'main' | 'aside' = 'main') {
  await page.viewport(mobile ? 390 : 1280, mobile ? 844 : 900)
  expect(window.innerWidth < 720).toBe(mobile)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'width:720px'
  root = createRoot(host)
  const render = (entryActive: boolean) => root!.render(<LocalizationProvider><ChatMessageComposer chatId="entry-group" currentUserId="owner" onSend={vi.fn(async () => {})} isGroupChat surface={surface} entryActive={entryActive} /></LocalizationProvider>)
  render(active)
  const editorSelector = `[data-testid="${surface === 'aside' ? 'chat-composer-aside' : 'chat-composer'}"]`
  await until('the actual group editor is mounted', () => !!host?.querySelector(editorSelector))
  const row = host.appendChild(document.createElement('button'))
  row.textContent = 'Conversation row'
  const editor = host.querySelector<HTMLElement>(editorSelector)!
  return { row, editor, render }
}

it('an explicit group entry hands focus to its existing editor and keeps the draft', async () => {
  const { row, editor, render } = await mount()
  await page.getByTestId('chat-composer').fill('Kept group draft')
  row.focus()
  requestComposerEntryFocus('chat:entry-group')
  await until('the requested group editor holds focus', () => document.activeElement === editor)
  expect(editor.textContent).toBe('Kept group draft')
  row.focus()
  render(true)
  await settle()
  expect(document.activeElement).toBe(row)
})

it('the named owner waits until its conversation becomes active', async () => {
  const { row, editor, render } = await mount(false)
  row.focus()
  requestComposerEntryFocus('chat:entry-group')
  await settle()
  expect(document.activeElement).toBe(row)
  render(true)
  await until('the newly active group answers the pending entry', () => document.activeElement === editor)
})

it('an entry for another conversation does not take the keyboard', async () => {
  const { row } = await mount()
  row.focus()
  requestComposerEntryFocus('chat:another-group')
  await settle()
  expect(document.activeElement).toBe(row)
})

it('a newer entry supersedes an owner that has not appeared yet', async () => {
  const { row, render } = await mount(false)
  row.focus()
  requestComposerEntryFocus('chat:entry-group')
  requestComposerEntryFocus('chat:another-group')
  render(true)
  await settle()
  expect(document.activeElement).toBe(row)
})

it('a mobile conversation entry keeps the keyboard closed', async () => {
  await page.viewport(390, 844)
  try {
    const { row } = await mount(true, true)
    row.focus()
    requestComposerEntryFocus('chat:entry-group')
    await settle()
    expect(document.activeElement).toBe(row)
  } finally {
    await page.viewport(1280, 900)
  }
})

it('a later resource opening cancels an entry whose composer has not appeared', async () => {
  const { row, render } = await mount(false)
  row.focus()
  requestComposerEntryFocus('chat:entry-group')
  requestComposerEntryFocus(null)
  render(true)
  await settle()
  expect(document.activeElement).toBe(row)
})

it('a topic aside does not consume a main conversation entry', async () => {
  const { row } = await mount(true, false, 'aside')
  row.focus()
  requestComposerEntryFocus('chat:entry-group')
  await settle()
  expect(document.activeElement).toBe(row)
})
