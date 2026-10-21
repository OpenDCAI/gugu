// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { listedSession, type DeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { useAppShowSession } from '../../../apps/desktop/src/mobile/agent-watch/useAppShowSession'
import { APP_SHOW_SESSION_EVENT, type AppShowSessionDetail } from '../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { createNode, createReactHarness } from '../../support/testHarness'

/**
 * `gugu.showSession` on the phone opens a row of the task tab's list (`listedSession`, the rows `directoryRows` gives the
 * list itself): an online machine's live list, an offline one's digest. Not listed: the machines not read say whether
 * that is an answer (none ⇒ on none of the person's computers) or a doubt (failed, naming them).
 */

const summary = (conversationId: string): SessionpageSessionSummary => ({
  conversationId,
  projectId: 'project-1',
  title: conversationId,
  harness: 'claude',
  runtime: 'acp',
  agentStatus: 'idle',
  lastInteractedAt: '2026-10-13T00:00:00.000Z',
  supported: true,
})
const device = (id: string, online: boolean, digest: string[] = []): Device => ({
  device_id: id,
  label: id.toUpperCase(),
  hostname: id,
  platform: 'darwin',
  status: online ? 'online' : 'offline',
  last_seen_at: '2026-10-13T00:00:00.000Z',
  is_online: online,
  capabilities: { terminals: [], runtimes: [] },
  session_digest: digest.map((conversationId) => ({
    conversationId,
    projectId: 'project-1',
    projectName: 'Project',
    title: conversationId,
    harness: 'claude',
    agentStatus: 'idle',
    lastInteractedAt: '2026-10-13T00:00:00.000Z',
    supported: true,
  })),
})
const live = (ids: string[], patch: Partial<DeviceSessions> = {}): DeviceSessions => ({
  projects: [],
  sessions: ids.map(summary),
  cached: false,
  loading: false,
  error: null,
  ...patch,
})

describe('listedSession: the row the task tab lists, or why it lists none', () => {
  it('an online machine\'s live list and an offline machine\'s digest are both rows, each on its own machine', () => {
    const devices = [device('on', true), device('off', false, ['s-off'])]
    const found = listedSession(devices, { on: live(['s-on']) }, 's-on')
    expect('row' in found && found.row.deviceId).toBe('on')
    const offline = listedSession(devices, { on: live(['s-on']) }, 's-off')
    expect('row' in offline && offline.row).toMatchObject({ deviceId: 'off', session: { conversationId: 's-off' } })
  })

  it('listed nowhere: every list read ⇒ no doubt; an online one still loading or failed ⇒ named', () => {
    const devices = [device('on', true), device('busy', true), device('off', false)]
    expect(listedSession(devices.slice(0, 1), { on: live([]) }, 's-x')).toEqual({ unread: [] })
    expect(listedSession(devices, { on: live([]), busy: live([], { loading: true }) }, 's-x')).toEqual({ unread: ['BUSY'] })
    expect(listedSession(devices, { on: live([], { error: 'boom' }) }, 's-x')).toEqual({ unread: ['ON', 'BUSY'] })
  })
})

describe('useAppShowSession: the shell brings the task tab forward and hands over the row', () => {
  let harness: ReturnType<typeof createReactHarness> | undefined
  afterEach(() => harness?.cleanup())

  it('each event: the task tab comes forward and a new request carries the row', async () => {
    harness = createReactHarness()
    const toTasks = vi.fn()
    const seen: Array<AppShowSessionDetail | null> = []
    const Probe = () => {
      seen.push(useAppShowSession(toTasks))
      return null
    }
    await harness.render(createNode(Probe, {}))
    expect(seen.at(-1)).toBeNull()
    const detail = { deviceId: 'on', session: summary('s-on') }
    await act(async () => { window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail })) })
    expect(toTasks).toHaveBeenCalledTimes(1)
    const first = seen.at(-1)
    expect(first).toEqual(detail)
    await act(async () => { window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail })) })
    expect(toTasks).toHaveBeenCalledTimes(2)
    expect(seen.at(-1), 'the same session asked twice is two requests').not.toBe(first)
  })
})
