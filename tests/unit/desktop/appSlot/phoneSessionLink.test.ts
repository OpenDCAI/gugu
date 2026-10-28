// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

/**
 * A gugu://session link on the phone: openLinkWith asks the shell first (the assistant's own task opens in its chat),
 * then the phone's task list finds the session and shows it (APP_SHOW_SESSION_EVENT) — the same steps the desktop
 * takes with its own lookup (gugu.showSession's).
 */
const shell = vi.hoisted(() => ({ opened: undefined as unknown }))
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
const { APP_SHOW_SESSION_EVENT } = await import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')
const { retainDeviceSessions, updateDeviceSessions } = await import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')

const session = { conversationId: 's1', projectId: 'p1', title: 'Task', harness: 'claude', runtime: 'acp', agentStatus: null,
  lastInteractedAt: '2026-10-27T00:00:00.000Z', supported: true } as SessionpageSessionSummary

afterEach(() => { retainDeviceSessions([]); shell.opened = undefined })

describe('a session link on the phone', () => {
  it('shows the session its task list has, when the shell did not open it', async () => {
    updateDeviceSessions('mac-1', { sessions: [session], cached: false, loading: false, error: null })
    const shown: unknown[] = []
    const listen = (event: Event) => shown.push((event as CustomEvent).detail)
    window.addEventListener(APP_SHOW_SESSION_EVENT, listen)
    try {
      await expect(openPhoneLink('gugu://session/s1')).resolves.toMatchObject({ kind: 'opened' })
      expect(shown).toEqual([{ deviceId: 'mac-1', session }])
      shell.opened = 'own'
      await openPhoneLink('gugu://session/s1')
      expect(shown).toHaveLength(1)
      shell.opened = undefined
      await expect(openPhoneLink('gugu://session/nowhere')).resolves.toMatchObject({ kind: 'failed', reason: 'no-session' })
    } finally {
      window.removeEventListener(APP_SHOW_SESSION_EVENT, listen)
    }
  })
})
