import { describe, expect, it } from 'vitest'
import { mainWindowSize } from '../../../../apps/desktop/electron/main-window-size'

describe('main window fits its display work area', () => {
  it('keeps initial and minimum bounds inside an 800×560 work area', () => {
    expect(mainWindowSize({ width: 800, height: 560 })).toEqual({
      width: 800, height: 560, minWidth: 800, minHeight: 560,
    })
  })

  it('caps the width floor too when the work area is narrower than the desktop target', () => {
    expect(mainWindowSize({ width: 640, height: 480 })).toEqual({
      width: 640, height: 480, minWidth: 640, minHeight: 480,
    })
  })

  it('preserves the normal initial target and minimum size on a large display', () => {
    expect(mainWindowSize({ width: 2560, height: 1440 })).toEqual({
      width: 1280, height: 900, minWidth: 800, minHeight: 600,
    })
  })

  it('caps saved bounds to the matching display rather than restoring them under the taskbar', () => {
    expect(mainWindowSize({ width: 1280, height: 720 }, { width: 1920, height: 1080 })).toEqual({
      width: 1280, height: 720, minWidth: 800, minHeight: 600,
    })
  })

  it('retains the normal floor for saved sizes when the display has room for it', () => {
    expect(mainWindowSize({ width: 1280, height: 800 }, { width: 500, height: 400 })).toEqual({
      width: 800, height: 600, minWidth: 800, minHeight: 600,
    })
  })
})
