import type { CSSProperties } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { IdeasEntry } from '../../features/assistant/assistant-ideas'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '../../features/assistant/assistant-today.css'
import '@/mobile/phone-look.css'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  delete document.documentElement.dataset.theme
})

function background(background: string, parent: Element) {
  const reference = document.createElement('div')
  reference.style.background = background
  parent.appendChild(reference)
  const style = getComputedStyle(reference)
  const result = { image: style.backgroundImage, color: style.backgroundColor }
  reference.remove()
  return result
}

it.each(['light', 'dark'] as const)('%s: phone Ideas stays neutral at rest and hover; desktop retains its tint', async (theme) => {
  document.documentElement.dataset.theme = theme
  const hue = { '--ta-tint-h': '83' } as CSSProperties
  await harness.render(<>
    <div data-phone-shell="" data-ta-scope="" style={hue}>
      <div className="ta-phone" style={hue}>
        <IdeasEntry assistantId="phone-tint-regression" busy={false} onOpen={() => {}} />
        <div className="ta-app" style={hue}><div data-ta-scope="" style={hue} /></div>
      </div>
    </div>
    <div className="ta-app" data-testid="desktop-tint" style={hue}>
      <IdeasEntry assistantId="desktop-tint-regression" busy={false} onOpen={() => {}} />
    </div>
  </>)
  const shell = harness.container.querySelector('[data-phone-shell]')!
  const phone = shell.querySelector<HTMLButtonElement>('[data-testid="assistant-ideas-entry"]')!
  const desktop = harness.container.querySelector('[data-testid="desktop-tint"]')!
  const desktopButton = desktop.querySelector<HTMLButtonElement>('button')!
  const neutral = 'color-mix(in oklab, var(--fg) 4%, transparent)'
  const rest = `linear-gradient(120deg, ${neutral}, transparent), var(--ta-composer-bg)`
  const hover = `linear-gradient(120deg, ${neutral}, ${neutral}), var(--ta-composer-bg)`
  await userEvent.hover(desktopButton)
  expect(background(getComputedStyle(phone).background, phone)).toEqual(background(rest, phone))
  // Nested assistant and onboarding scopes redeclare the tint tokens; each must remain neutral.
  for (const scope of [shell, ...shell.querySelectorAll('.ta-phone, .ta-app, [data-ta-scope]')]) {
    expect(background('var(--ta-tint-wash)', scope)).toEqual(background(neutral, scope))
  }
  await userEvent.hover(phone)
  expect(background(getComputedStyle(phone).background, phone)).toEqual(background(hover, phone))

  // Independent baseline: the existing desktop pigment, opacity and hover treatment.
  const tint = theme === 'light' ? 'oklch(0.62 0.12 83)' : 'oklch(0.74 0.1 83)'
  const wash = `color-mix(in oklab, ${tint} ${theme === 'light' ? 11 : 13}%, transparent)`
  const soft = `color-mix(in oklab, ${tint} ${theme === 'light' ? 14 : 20}%, transparent)`
  expect(background(getComputedStyle(desktopButton).background, desktopButton))
    .toEqual(background(`linear-gradient(120deg, ${wash}, transparent), var(--ta-composer-bg)`, desktopButton))
  await userEvent.hover(desktopButton)
  expect(background(getComputedStyle(desktopButton).background, desktopButton))
    .toEqual(background(`linear-gradient(120deg, ${soft}, ${wash}), var(--ta-composer-bg)`, desktopButton))
})
