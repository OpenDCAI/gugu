// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

/**
 * A gugu://session link on the phone: openLinkWith asks the shell first (the assistant's own task opens in its chat),
 * then the phone's task list finds the session and shows it (APP_SHOW_SESSION_EVENT) — the same steps the desktop
 * takes with its own lookup (gugu.showSession's).
 */
const shell = vi.hoisted(() => ({ opened: undefined as unknown, notice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: shell.notice }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', async (original) => ({
  ...(await original<typeof import('../../../../apps/desktop/src/lib/guguLinks')>()),
  openLinkTarget: vi.fn(async () => shell.opened),
}))
const device = { device_id: 'mac-1', label: 'Mac', hostname: 'mac', platform: 'darwin', status: 'online', last_seen_at: '2026-10-27T00:00:00.000Z',
  is_online: true, capabilities: { terminals: [], runtimes: [] } } as Device
vi.mock('../../../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => [device] }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { manifests: [], isEnabled: () => true, manifestFor: () => undefined, icons: {} },
}))
const { openPhoneLink } = await import('../../../../apps/desktop/src/components/appSlot/phoneAppHost')
const { followLink } = await import('../../../../apps/desktop/src/lib/guguLinks')
const { APP_SHOW_SESSION_EVENT } = await import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')
const { retainDeviceSessions, updateDeviceSessions } = await import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')

const session = { conversationId: 's1', projectId: 'p1', title: 'Task', harness: 'claude', runtime: 'acp', agentStatus: null,
  lastInteractedAt: '2026-10-27T00:00:00.000Z', supported: true } as SessionpageSessionSummary

afterEach(() => { retainDeviceSessions([]); shell.opened = undefined; shell.notice.mockClear(); device.is_online = true; device.session_digest = [] })

describe('a session link on the phone', () => {
  it('shows the session its task list has, when the shell did not open it', async () => {
    updateDeviceSessions('mac-1', { sessions: [session], cached: false, loading: false, error: null })
    const shown: unknown[] = []
    const listen = (event: Event) => shown.push((event as CustomEvent).detail)
    window.addEventListener(APP_SHOW_SESSION_EVENT, listen)
    try {
      await expect(openPhoneLink('gugu-session://s1?message=turn-1')).resolves.toMatchObject({ kind: 'opened' })
      expect(shown).toEqual([{ deviceId: 'mac-1', session }])
      expect(shell.notice).not.toHaveBeenCalled()
      shell.opened = 'own'
      await openPhoneLink('gugu://session/s1')
      expect(shown).toHaveLength(1)
      shell.opened = undefined
      await expect(openPhoneLink('gugu-session://nowhere?message=turn-1')).resolves.toMatchObject({ kind: 'failed', reason: 'no-session' })
      expect(followLink('gugu-session://nowhere?message=turn-1')).toBe(true)
      await vi.waitFor(() => expect(shell.notice).toHaveBeenCalledExactlyOnceWith({ tier: 'error', title: 'session: no-session' }))
    } finally {
      window.removeEventListener(APP_SHOW_SESSION_EVENT, listen)
    }
  })

  it('reports one visible failure for a listed task that the phone cannot open', async () => {
    device.is_online = false
    device.session_digest = [{ conversationId: 's1', projectId: 'p1', projectName: 'Project', title: 'Task',
      harness: 'claude', agentStatus: 'idle', lastInteractedAt: '2026-10-27T00:00:00.000Z', supported: false }]
    const shown = vi.fn()
    window.addEventListener(APP_SHOW_SESSION_EVENT, shown)
    try {
      const result = await openPhoneLink('gugu-session://s1?message=turn-1')
      expect(result).toMatchObject({ kind: 'failed', reason: 'open-failed' })
      expect(shown).not.toHaveBeenCalled()
      expect(followLink('gugu-session://s1?message=turn-1')).toBe(true)
      await vi.waitFor(() => expect(shell.notice).toHaveBeenCalledExactlyOnceWith({
        tier: 'error', title: expect.stringContaining(String(result.kind === 'failed' ? result.detail : 'missing failure')),
      }))
    } finally { window.removeEventListener(APP_SHOW_SESSION_EVENT, shown) }
  })
})
