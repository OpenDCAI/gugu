import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ status: vi.fn(), smsList: vi.fn(), smsGet: vi.fn(), mediaList: vi.fn(), mediaRead: vi.fn() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

import { PHONE_ACTION_GROUPS, buildPhoneActionsCapability, missingRequirements, phoneActionByName, type PhoneGroupGrants, type PhoneOsState } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'
import { NO_PHONE_DATA, readPhoneDataStatus } from '../../../../apps/desktop/src/mobile/phone-device/phoneDataActions'
import { createPhoneActionProvider } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionProvider'

const os = (): PhoneOsState => ({
  runtime: { calendar: 'granted', contacts: 'granted', location: 'granted', coarseLocation: 'granted' },
  special: { notification_listener: true, dnd_access: true, location_enabled: true, background_location: true, alarm_app: true, foreground: true },
  health: { supported: false, granted_types: [], background_supported: false, background_granted: false },
  data: { ...NO_PHONE_DATA, supported: true, sms: true, audio: true, selected: true },
})
const grants = (on: boolean) => Object.fromEntries(PHONE_ACTION_GROUPS.map((g) => [g, on])) as PhoneGroupGrants

beforeEach(() => vi.resetAllMocks())

describe('phone read permission boundary', () => {
  it('keeps all six new actions unavailable until their own group is connected', () => {
    const entries = buildPhoneActionsCapability(grants(false), os()).actions.filter((a) => ['sms', 'recordings', 'photos'].includes(a.group))
    expect(entries).toHaveLength(6)
    expect(entries.every((a) => !a.available && a.unavailable_reason === 'not_granted')).toBe(true)
    expect(entries.every((a) => a.confirm === 'never')).toBe(true)
  })
  it('accepts selected-photo access without claiming full photo/video access', () => {
    const state = os()
    expect(missingRequirements('photos', state)).toEqual([])
    const entries = buildPhoneActionsCapability(grants(true), state).actions
    expect(entries.find((a) => a.name === 'photos.list')?.available).toBe(true)
    state.data = { ...NO_PHONE_DATA, supported: true }
    expect(missingRequirements('photos', state)).toEqual(['photos'])
    expect(buildPhoneActionsCapability(grants(true), state).actions.find((a) => a.name === 'photos.read')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
  })
  it('reports an old APK as unsupported rather than asking for permissions it cannot request', () => {
    const state = os(); state.data = NO_PHONE_DATA
    expect(buildPhoneActionsCapability(grants(true), state).actions.find((a) => a.name === 'sms.list')).toMatchObject({ available: false, unavailable_reason: 'unsupported' })
  })
  it('rechecks the actual provider permit after a group or system permission is revoked', () => {
    const state = os(); let connected = true
    const provider = createPhoneActionProvider({ action: phoneActionByName, granted: () => connected, os: () => state, manifest: () => [] })
    expect(provider.permit('recordings.read')).toEqual({ ok: true })
    state.data!.audio = false
    expect(provider.permit('recordings.read')).toMatchObject({ ok: false, code: 'os_permission' })
    connected = false
    expect(provider.permit('sms.get')).toMatchObject({ ok: false, code: 'not_granted' })
  })
})

describe('phone read arguments and native failures', () => {
  it('converts explicit-zone time filters and preserves pagination, search and address', async () => {
    native.smsList.mockResolvedValue({ messages: [], next_before_id: null })
    await phoneActionByName('sms.list')!.run({ query: '取件', address: '106', after: '2026-10-19T00:00:00+08:00', before_id: '42', limit: 10 })
    expect(native.smsList).toHaveBeenCalledWith({ query: '取件', address: '106', after_ms: Date.parse('2026-10-19T00:00:00+08:00'), before_id: '42', limit: 10 })
  })
  it('rejects paths and arbitrary content URIs instead of forwarding them to Android', async () => {
    for (const id of ['../../other-app', 'content://sms/1', '1 OR 1=1', '-1', '0']) {
      expect(() => phoneActionByName('photos.read')!.run({ id, _phone_file_transport: 1 })).toThrow(/编号/)
    }
    expect(native.mediaRead).not.toHaveBeenCalled()
  })
  it('rejects invalid time ranges and video kinds before native execution', () => {
    expect(() => phoneActionByName('recordings.list')!.run({ after: '2026-10-19' })).toThrow(/时区/)
    expect(() => phoneActionByName('sms.list')!.run({ after: '2026-10-20T00:00:00Z', before: '2026-10-19T00:00:00Z' })).toThrow(/晚于/)
    expect(() => phoneActionByName('photos.list')!.run({ kind: 'audio' })).toThrow(/kind/)
  })
  it('refuses old receiver hosts before reading any media bytes', () => {
    expect(() => phoneActionByName('recordings.read')!.run({ id: '12' })).toThrow(/更新 agent/)
    expect(native.mediaRead).not.toHaveBeenCalled()
  })
  it('routes recordings to the audio collection and photos to the declared collection', async () => {
    await phoneActionByName('recordings.read')!.run({ id: '12', version: '12:100:2', _phone_file_transport: 1 })
    expect(native.mediaRead).toHaveBeenCalledWith({ id: '12', kind: 'audio', version: '12:100:2' })
    await phoneActionByName('photos.list')!.run({ kind: 'video' })
    expect(native.mediaList).toHaveBeenCalledWith({ kind: 'video' })
  })
  it('keeps native permission refusals as os_permission', async () => {
    native.smsGet.mockRejectedValue({ code: 'os_permission', message: 'installer refused SMS' })
    const provider = createPhoneActionProvider({ action: phoneActionByName, granted: () => true, os, manifest: () => [] })
    expect(await provider.run('sms.get', { id: '1' }, { callId: 'test', signal: new AbortController().signal, note: () => undefined })).toMatchObject({ ok: false, code: 'os_permission', message: 'installer refused SMS' })
  })
  it('recognizes a missing native plugin but does not swallow other status failures', async () => {
    native.status.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
    expect(await readPhoneDataStatus()).toEqual(NO_PHONE_DATA)
    native.status.mockRejectedValueOnce(new Error('broken bridge'))
    await expect(readPhoneDataStatus()).rejects.toThrow('broken bridge')
  })
})
