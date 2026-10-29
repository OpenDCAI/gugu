// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { qrColors } from '../../../../apps/desktop/src/lib/qrColors'

// theme batch D: QR codes read --qr-ink / --qr-paper at render time; unreadable tokens must never yield a colourless code.
describe('qrColors', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--qr-ink')
    document.documentElement.style.removeProperty('--qr-paper')
  })

  it('takes the tokens once the theme is on the page', () => {
    document.documentElement.style.setProperty('--qr-ink', '#1f2933')
    document.documentElement.style.setProperty('--qr-paper', '#ffffff')
    expect(qrColors()).toEqual({ dark: '#1f2933', light: '#ffffff' })
  })

  it('tokens not readable yet: no colour option, so qrcode keeps its own black on white', () => {
    expect(qrColors()).toBeUndefined()
    document.documentElement.style.setProperty('--qr-ink', '#1f2933')
    expect(qrColors()).toBeUndefined()
  })
})
