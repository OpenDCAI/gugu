// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { framedHost } from '../../../../apps/desktop/src/session/app-runtime/framed-host'
import { APP_SESSION_FRAME_NAME } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * Explicit device calls do not require a task tab. Notifications still belong to the task's computer.
 */
afterEach(() => {
  window.name = ''
})

describe('the phone frame host supports explicit devices outside task tabs', () => {
  it('a chat panel exposes callProgram and sessions, with notifications limited to task tabs', () => {
    window.name = ''
    const host = framedHost()
    expect(typeof host.callProgram).toBe('function')
    expect(typeof host.sessions?.index).toBe('function')
    expect(typeof host.sessions?.read).toBe('function')
    expect(typeof host.onProgramNotification).toBe('undefined')
    expect(typeof host.readData).toBe('function')
  })

  it('a session\'s tab (the frame SessionAppFrame names): both are there', () => {
    window.name = APP_SESSION_FRAME_NAME
    const host = framedHost()
    expect(typeof host.callProgram).toBe('function')
    expect(typeof host.onProgramNotification).toBe('function')
  })
})
