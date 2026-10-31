import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'

let root: Root | null = null
let host: HTMLDivElement | null = null
const onSend = vi.fn(async (_text: string) => {})
const editor = () => page.getByTestId('chat-composer')
const picker = () => document.querySelector('[data-slot="composer-menu"][role="listbox"]')
const text = () => editor().element().textContent

describe.each([1100, 390])('IM composer has no slash commands at viewport width %i', (width) => {
  beforeEach(async () => {
    setLocalePreference('en-US')
    onSend.mockClear()
    await page.viewport(width, 740)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<LocalizationProvider><ChatMessageComposer onSend={onSend} /></LocalizationProvider>)
    await editor().click()
  })

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
  })

  it('does not open commands for a slash inside a file path', async () => {
    const draft = 'Review /Users/mac1/Codebase/project and tests/unit/desktop/components/'
    await userEvent.keyboard(draft)
    expect(text()).toBe(draft)
    expect(picker()).toBeNull()
    await userEvent.keyboard('{Enter}')
    if (width > 720) {
      await until('path draft is sent', () => onSend.mock.calls.length === 1)
      expect(onSend.mock.calls[0]?.[0]).toBe(draft)
    } else {
      expect(text()).toBe(draft)
      expect(editor().element().querySelector('br')).not.toBeNull()
      expect(onSend).not.toHaveBeenCalled()
    }
  })

  it('opens no command menu for a slash and still sends the draft on Enter', async () => {
    await userEvent.keyboard('Keep this draft /')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(picker()).toBeNull()
    await userEvent.keyboard('{Enter}')
    if (width > 720) {
      await until('ordinary Enter sends the draft', () => onSend.mock.calls.length === 1)
      expect(onSend.mock.calls[0]?.[0]).toBe('Keep this draft /')
    } else {
      expect(text()).toBe('Keep this draft /')
      expect(editor().element().querySelector('br')).not.toBeNull()
      expect(onSend).not.toHaveBeenCalled()
    }
  })

  it('keeps the complete prompt when a path-filled message is submitted immediately', async () => {
    const draft = 'Please inspect /Users/mac1/Codebase/project and run tests/unit/desktop/components/runningTokenPreview.test.tsx'
    await userEvent.keyboard(draft)
    await userEvent.keyboard('{Enter}')
    if (width > 720) {
      await until('the complete prompt is sent', () => onSend.mock.calls.length === 1)
      expect(onSend.mock.calls[0]?.[0]).toBe(draft)
    } else {
      expect(text()).toBe(draft)
      expect(editor().element().querySelector('br')).not.toBeNull()
      expect(onSend).not.toHaveBeenCalled()
    }
  })
})
