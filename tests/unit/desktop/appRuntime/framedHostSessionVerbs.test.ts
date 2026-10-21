// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { framedHost } from '../../../../apps/desktop/src/session/app-runtime/framed-host'
import { APP_SESSION_FRAME_NAME } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * owner 10-16 / 复核 #7300 要改 1: on the phone a page calls an App's program only from a session's tab (that session's
 * computer runs it). Anywhere else — a chat's panel — the phone has no program, and the verbs are missing, not refused:
 * an App tells the phone by `typeof gugu.callProgram` (全能搜索 does), as framed-host.ts promises.
 */
afterEach(() => {
  window.name = ''
})

describe('the phone frame host offers a program only in a session\'s tab', () => {
  it('a chat\'s panel: no callProgram, no onProgramNotification — its own data verbs still there', () => {
    window.name = ''
    const host = framedHost()
    expect(typeof host.callProgram).toBe('undefined')
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
