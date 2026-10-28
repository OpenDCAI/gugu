import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #7199 手机当设备 —— 手机登记给云端的动作清单、交给 core 设备动作 host 的 provider、设备行、
// 与看管机器共用的「后台守着」常驻通知。原生插件全部换成假的,收发规矩走真的 host。

const native = vi.hoisted(() => ({
  calendarList: vi.fn(),
  calendarCreate: vi.fn(),
  locationCurrent: vi.fn(),
  dndSet: vi.fn(),
  alarmSet: vi.fn(),
  notificationsList: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => native,
}))

const platformMock = vi.hoisted(() => ({
  capabilities: { backgroundWatch: true },
  setBackgroundWatch: vi.fn(async () => undefined),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: platformMock }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({
  rendererLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  DEVICE_ACTION_PROGRESS_INTERVAL_MS,
  DEVICE_ACTION_RESULT_EVENT,
  DEVICE_ACTION_RESULT_RESEND_MS,
  type DeviceActionResult,
} from '@gugu/core/shared/deviceActions'
import { createDeviceActionHost, type DeviceActionCallRecord } from '@gugu/core/cloud/deviceActionHost'
import { isAgentHostDevice, isPhoneDevice, listDevices } from '@gugu/core/cloud/devices'
import {
  PHONE_ACTIONS,
  PhoneActionFailure,
  buildPhoneActionsCapability,
  localIso,
  missingRequirements,
  phoneActionByName,
  type PhoneActionGroup,
  type PhoneGroupGrants,
  type PhoneOsState,
} from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'
import { createPhoneActionProvider, mergeCallRecord } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionProvider'
import { phoneDeviceRow, phoneLabel, tierOfPackage } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRow'
import { phoneDeviceId, phoneInstallId } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'
import { deviceRpcChannelName } from '@gugu/core/cloud/deviceRpcProtocol'
import { backgroundWatchLabel, backgroundWatchText, claimBackgroundWatch } from '../../../../apps/desktop/src/mobile/backgroundWatchClaims'

const ALL_ON: PhoneGroupGrants = { calendar: true, contacts: true, location: true, notifications: true, alarm: true, health: true, sms: true, recordings: true, photos: true }
const ALL_OFF: PhoneGroupGrants = { calendar: false, contacts: false, location: false, notifications: false, alarm: false, health: false, sms: false, recordings: false, photos: false }

function osState(
  overrides: Partial<PhoneOsState['special']> = {},
  runtime: Partial<PhoneOsState['runtime']> = {},
  health: Partial<PhoneOsState['health']> = {},
): PhoneOsState {
  return {
    data: { supported: true, sms: true, audio: true, images: true, videos: true, selected: false },
    runtime: { calendar: 'granted', contacts: 'granted', location: 'granted', coarseLocation: 'granted', ...runtime },
    special: {
      notification_listener: true,
      dnd_access: true,
      location_enabled: true,
      background_location: true,
      alarm_app: true,
      foreground: true,
      ...overrides,
    },
    health: { supported: true, granted_types: ['steps', 'sleep'], background_supported: true, background_granted: true, ...health },
  }
}

describe('登记清单', () => {
  it('二十一个动作全登记,没授权的也登记、标不可用并说清为什么', () => {
    const capability = buildPhoneActionsCapability(ALL_OFF, osState(), new Date('2026-10-15T04:00:00Z'))
    expect(capability.actions.map((a) => a.name)).toEqual([
      'calendar.events.list', 'calendar.events.create', 'calendar.events.update', 'calendar.events.delete',
      'contacts.list', 'location.current', 'notifications.list', 'dnd.set', 'alarm.set', 'timer.start',
      'health.summary', 'health.sleep', 'health.workouts', 'health.heart_rate', 'health.body',
      'sms.list', 'sms.get', 'recordings.list', 'recordings.read', 'photos.list', 'photos.read',
    ])
    for (const action of capability.actions) {
      expect(action.available).toBe(false)
      expect(action.unavailable_reason).toBe('not_granted')
      expect(action.unavailable_detail).toContain('我的 → 这台手机')
    }
    expect(capability.timezone).toBeTruthy()
  })

  it('改日历、取定位、开勿扰要先在聊天里问人;读的不用', () => {
    const always = PHONE_ACTIONS.filter((a) => a.confirm === 'always').map((a) => a.name)
    expect(always).toEqual(['calendar.events.create', 'calendar.events.update', 'calendar.events.delete', 'location.current', 'dnd.set'])
  })

  it('组开着、系统没给 ⇒ os_permission;没有时钟 App ⇒ unsupported', () => {
    const capability = buildPhoneActionsCapability(ALL_ON, osState({ notification_listener: false, alarm_app: false }, { calendar: 'denied' }))
    const byName = new Map(capability.actions.map((a) => [a.name, a]))
    expect(byName.get('calendar.events.list')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(byName.get('notifications.list')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(byName.get('dnd.set')).toMatchObject({ available: true })
    expect(byName.get('alarm.set')).toMatchObject({ available: false, unavailable_reason: 'unsupported' })
    expect(byName.get('contacts.list')).toMatchObject({ available: true })
  })

  it('系统框里只给了「大致位置」⇒ 定位照样可用(「我在哪」用大致位置也答得上)', () => {
    const actions = buildPhoneActionsCapability(ALL_ON, osState({}, { location: 'denied', coarseLocation: 'granted' })).actions
    expect(actions.find((a) => a.name === 'location.current')).toMatchObject({ available: true })
    expect(missingRequirements('location', osState({}, { location: 'denied', coarseLocation: 'granted' }))).toEqual([])
    expect(missingRequirements('location', osState({}, { location: 'denied', coarseLocation: 'denied' }))).toEqual(['location'])
  })

  it('定位总开关关着 ⇒ 定位不可用', () => {
    const capability = buildPhoneActionsCapability(ALL_ON, osState({ location_enabled: false }))
    expect(capability.actions.find((a) => a.name === 'location.current')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
  })

  it('日历动作的说明里写着手机的时区(助理在云电脑上,时区未必一样)', () => {
    const capability = buildPhoneActionsCapability(ALL_ON, osState())
    expect(capability.actions[0]?.description).toContain(capability.timezone)
  })
})

describe('动作在手机上怎么做', () => {
  beforeEach(() => vi.clearAllMocks())

  it('查某一天的日程:按手机本地那一整天去问系统,时间按手机本地时间交回', async () => {
    native.calendarList.mockResolvedValue({
      timezone: 'Asia/Shanghai',
      events: [{ event_id: '7', title: '组会', start_ms: Date.parse('2026-10-16T07:00:00Z'), end_ms: Date.parse('2026-10-16T08:00:00Z'), all_day: false, location: '', description: '', calendar: '本机', calendar_id: '1' }],
    })
    const data = await phoneActionByName('calendar.events.list')!.run({ date: '2026-10-16' }) as { events: Array<Record<string, unknown>> }
    const [args] = native.calendarList.mock.calls[0] as [{ start_ms: number; end_ms: number }]
    expect(args.end_ms - args.start_ms).toBe(24 * 3600_000)
    expect(new Date(args.start_ms).getHours()).toBe(0)
    expect(data.events[0]).toMatchObject({ event_id: '7', title: '组会', all_day: false, start: localIso(Date.parse('2026-10-16T07:00:00Z')) })
  })

  it('查某一天:系统按 UTC 沾边带出来的前后一天的全天日程筛掉,只留那一天的', async () => {
    const allDay = (id: string, day: number) => ({
      event_id: id, title: id, start_ms: Date.UTC(2026, 9, day), end_ms: Date.UTC(2026, 9, day + 1), all_day: true,
      location: '', description: '', calendar: '节假日', calendar_id: '2',
    })
    native.calendarList.mockResolvedValue({ timezone: 'Asia/Shanghai', events: [allDay('15号', 15), allDay('16号', 16), allDay('17号', 17)] })
    const data = await phoneActionByName('calendar.events.list')!.run({ date: '2026-10-16' }) as { events: Array<Record<string, unknown>> }
    expect(data.events).toEqual([expect.objectContaining({ event_id: '16号', all_day: true, start_date: '2026-10-16', end_date: '2026-10-17' })])
  })

  it('全天日程按 UTC 零点存(系统日历的存法),end 缺省 = 当天', async () => {
    native.calendarCreate.mockResolvedValue({ event_id: '9', calendar_id: '1' })
    await phoneActionByName('calendar.events.create')!.run({ title: '出差', start: '2026-10-20', all_day: true })
    expect(native.calendarCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '出差', all_day: true, start_ms: Date.UTC(2026, 9, 20), end_ms: Date.UTC(2026, 9, 21),
    }))
  })

  it('参数不对当场 invalid_args,❌ 交给原生', async () => {
    await expect(phoneActionByName('calendar.events.create')!.run({ start: '2026-10-20T10:00:00+08:00' })).rejects.toMatchObject({ code: 'invalid_args' })
    await expect(phoneActionByName('dnd.set')!.run({ mode: 'loud' })).rejects.toBeInstanceOf(PhoneActionFailure)
    expect(native.calendarCreate).not.toHaveBeenCalled()
    expect(native.dndSet).not.toHaveBeenCalled()
  })

  it('原生 reject 的码翻成合同里的码:要前台 ⇒ execution_failed,系统权限 ⇒ os_permission', async () => {
    native.alarmSet.mockRejectedValue(Object.assign(new Error('设闹钟要咕咕在前台'), { code: 'needs_foreground' }))
    await expect(phoneActionByName('alarm.set')!.run({ hour: 7, minute: 30 })).rejects.toMatchObject({ code: 'execution_failed', message: '设闹钟要咕咕在前台' })
    native.locationCurrent.mockRejectedValue(Object.assign(new Error('没有定位权限'), { code: 'os_permission' }))
    await expect(phoneActionByName('location.current')!.run({})).rejects.toMatchObject({ code: 'os_permission' })
  })

  it('读通知按 App 名筛', async () => {
    native.notificationsList.mockResolvedValue({ notifications: [
      { key: 'a', app: '微信', package: 'com.tencent.mm', title: '张三', text: '在吗', posted_at: 1, ongoing: false, active: true },
      { key: 'b', app: '淘宝', package: 'com.taobao.taobao', title: '物流', text: '已签收', posted_at: 2, ongoing: false, active: false },
    ] })
    const data = await phoneActionByName('notifications.list')!.run({ app: '微信' }) as { notifications: Array<{ app: string }> }
    expect(data.notifications.map((n) => n.app)).toEqual(['微信'])
  })
})

describe('交给 core 设备动作 host 的 provider(与桌面同一份收发规矩)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T04:00:00Z'))
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  function setup(grants: { current: PhoneGroupGrants }, os: PhoneOsState = osState()) {
    const events: Array<Record<string, unknown>> = []
    const records: Array<Record<string, unknown>> = []
    const provider = createPhoneActionProvider({
      action: phoneActionByName,
      granted: (group: PhoneActionGroup) => grants.current[group],
      os: () => os,
      manifest: () => buildPhoneActionsCapability(grants.current, os).actions,
      record: (entry) => records.push({ ...entry }),
    })
    const host = createDeviceActionHost({ provider, publishEvent: (payload) => { events.push(payload as Record<string, unknown>) } })
    return { host, events, records }
  }

  const call = (action: string, args: Record<string, unknown> = {}, callId = 'c1') => ({
    v: 1,
    call_id: callId,
    action,
    args,
    timeout_ms: 30_000,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    caller: { name: '个人助理' },
  })

  it('没连上这一组 ⇒ 开工前就回 not_granted,❌ 碰原生', async () => {
    const { host } = setup({ current: ALL_OFF })
    const reply = await host.handleCall(call('calendar.events.list', { date: '2026-10-16' }))
    expect(reply.result).toMatchObject({ ok: false, code: 'not_granted' })
    expect(native.calendarList).not.toHaveBeenCalled()
  })

  it('系统没给 ⇒ os_permission,message 说去哪开', async () => {
    const { host } = setup({ current: ALL_ON }, osState({}, { location: 'denied', coarseLocation: 'denied' }))
    const reply = await host.handleCall(call('location.current', { confirmed: true }))
    expect(reply.result).toMatchObject({ ok: false, code: 'os_permission' })
    expect((reply.result as { message: string }).message).toContain('去授权')
  })

  it('取定位不带 confirmed ⇒ needs_confirmation 带着要问人的那一句;带了才真去取', async () => {
    const { host, events } = setup({ current: ALL_ON })
    const first = await host.handleCall(call('location.current', {}, 'c-ask'))
    expect(first.result).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '要读一下手机现在的位置吗?' } })
    expect(native.locationCurrent).not.toHaveBeenCalled()

    native.locationCurrent.mockResolvedValue({ latitude: 31.23, longitude: 121.47, accuracy_m: 20, provider: 'network', fixed_at_ms: Date.now(), cached: false, coordinate_system: 'WGS84', address: '上海市黄浦区' })
    const second = await host.handleCall(call('location.current', { confirmed: true }, 'c-go'))
    expect(second.result).toMatchObject({ state: 'accepted', call_id: 'c-go' })
    await vi.advanceTimersByTimeAsync(0)
    const result = events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT && e.call_id === 'c-go')
    expect((result?.result as DeviceActionResult)).toMatchObject({ ok: true, data: { latitude: 31.23, longitude: 121.47, address: '上海市黄浦区' } })
  })

  it('执行中关掉这一组 ⇒ 下一次报进度前判 revoked', async () => {
    const grants = { current: { ...ALL_ON } }
    const { host, events } = setup(grants)
    native.calendarList.mockReturnValue(new Promise(() => undefined))
    await host.handleCall(call('calendar.events.list', {}, 'c-slow'))
    grants.current = { ...ALL_ON, calendar: false }
    await vi.advanceTimersByTimeAsync(DEVICE_ACTION_PROGRESS_INTERVAL_MS + 10)
    const result = events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT && e.call_id === 'c-slow')
    expect((result?.result as DeviceActionResult)).toMatchObject({ ok: false, code: 'revoked' })
  })

  it('同一个 call_id 重来回同一份结果,❌ 再建一条日程;没收到「结果收到」就每 5 秒重推', async () => {
    const { host, events } = setup({ current: ALL_ON })
    native.calendarCreate.mockResolvedValue({ event_id: '42', calendar_id: '1' })
    const args = { title: '看牙', start: '2026-10-16T15:00:00+08:00', confirmed: true }
    await host.handleCall(call('calendar.events.create', args, 'c-once'))
    await vi.advanceTimersByTimeAsync(0)
    const again = await host.handleCall(call('calendar.events.create', args, 'c-once'))
    expect(again.result).toMatchObject({ ok: true, data: { event_id: '42' } })
    expect(native.calendarCreate).toHaveBeenCalledTimes(1)
    const before = events.filter((e) => e.type === DEVICE_ACTION_RESULT_EVENT).length
    await vi.advanceTimersByTimeAsync(DEVICE_ACTION_RESULT_RESEND_MS + 10)
    expect(events.filter((e) => e.type === DEVICE_ACTION_RESULT_EVENT).length).toBe(before + 1)
    host.handleResultAck({ call_id: 'c-once' })
    await vi.advanceTimersByTimeAsync(DEVICE_ACTION_RESULT_RESEND_MS * 3)
    expect(events.filter((e) => e.type === DEVICE_ACTION_RESULT_EVENT).length).toBe(before + 1)
    host.dispose()
  })

  it('最近调用:开始一条、结束更新同一条,记下谁调的', async () => {
    const { host, records } = setup({ current: ALL_ON })
    native.calendarList.mockResolvedValue({ timezone: 'Asia/Shanghai', events: [] })
    await host.handleCall(call('calendar.events.list', {}, 'c-rec'))
    await vi.advanceTimersByTimeAsync(0)
    expect(records.map((r) => r.callId)).toEqual(['c-rec', 'c-rec'])
    expect(records[1]).toMatchObject({ ok: true, caller: { name: '个人助理' } })
    type Row = DeviceActionCallRecord & { title: string }
    const merged = records.reduce<Row[]>((list, r) => mergeCallRecord(list, { ...(r as unknown as DeviceActionCallRecord), title: 't' }, 30), [])
    expect(merged).toHaveLength(1)
    host.dispose()
  })
})

describe('设备行', () => {
  const info = { manufacturer: 'Xiaomi', brand: 'Redmi', model: '23127PN0CC', android: '15', sdk: 35, rom: 'HyperOS OS2.0', device_name: null, app_version: '0.2.55', package: 'app.gugu.chat.cloudtest', install_key: null }

  it('档位按包名:正式、Beta、并存的测试包各占一行', () => {
    expect(tierOfPackage('app.gugu.chat')).toBe('production')
    expect(tierOfPackage('app.gugu.chat.beta')).toBe('beta')
    expect(tierOfPackage('app.gugu.chat.cloudtest')).toBe('cloudtest')
  })

  it('名字优先用系统里的设备名,没有就品牌 + 型号', () => {
    expect(phoneLabel({ ...info, device_name: 'Redmi K70' })).toBe('Redmi K70')
    expect(phoneLabel(info)).toBe('Redmi 23127PN0CC')
  })

  it('device_id 不带冒号:频道 gugu:{device_id}:rpc 按冒号取第 2 段放行', () => {
    const id = phoneDeviceId('d53f37f0-598f-47e4-bda6-6e6fd29d3dd5', 'ab708bb4-ce65-4afa-b645-3634229deaf3')
    expect(deviceRpcChannelName(id).split(':')).toEqual(['gugu', id, 'rpc'])
  })

  it('host_kind = phone,动作清单随行', () => {
    const actions = buildPhoneActionsCapability(ALL_ON, osState())
    const row = phoneDeviceRow({ deviceId: 'phone-i-u', userId: 'u', installId: 'i', info, actions, nowIso: '2026-10-15T04:00:00.000Z' })
    expect(row).toMatchObject({ device_id: 'phone-i-u', platform: 'android', tier: 'cloudtest', status: 'online', machine_id: 'i' })
    expect(row.capabilities).toMatchObject({ host_kind: 'phone', os_name: 'Android 15 · HyperOS OS2.0', app_version: '0.2.55', actions })
  })

  it('「在哪跑」读的设备列表默认不含手机;要手机的显式带 includePhones', async () => {
    const rows = [
      { device_id: 'mac', label: 'Mac', hostname: 'mac', platform: 'darwin', status: 'online', last_seen_at: '2026-10-15T04:00:00Z', capabilities: { host_kind: 'desktop' } },
      { device_id: 'phone-i-u', label: 'Redmi', hostname: 'Xiaomi', platform: 'android', status: 'online', last_seen_at: '2026-10-15T04:00:00Z', capabilities: { host_kind: 'phone' } },
    ]
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }) }),
    } as unknown as Parameters<typeof listDevices>[0]
    expect((await listDevices(client, 'u')).map((d) => d.device_id)).toEqual(['mac'])
    const all = await listDevices(client, 'u', { includePhones: true })
    expect(all.map((d) => d.device_id)).toEqual(['mac', 'phone-i-u'])
    expect(all.filter(isPhoneDevice).map((d) => d.device_id)).toEqual(['phone-i-u'])
  })

  it('native host ready phones enter run targets, while incomplete advertisements stay out', async () => {
    const rows = [
      { device_id: 'phone-ready', label: 'Phone', hostname: 'Phone', platform: 'android', status: 'online', last_seen_at: '2026-10-20T04:00:00Z', capabilities: { host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] } },
      { device_id: 'phone-starting', label: 'Phone', hostname: 'Phone', platform: 'android', status: 'online', last_seen_at: '2026-10-20T04:00:00Z', capabilities: { host_kind: 'phone', host_runtime_capability: 0, runtimes: ['pi'] } },
      { device_id: 'phone-no-engine', label: 'Phone', hostname: 'Phone', platform: 'android', status: 'online', last_seen_at: '2026-10-20T04:00:00Z', capabilities: { host_kind: 'phone', host_runtime_capability: 1, runtimes: [] } },
    ]
    const client = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }) }) } as unknown as Parameters<typeof listDevices>[0]
    expect((await listDevices(client, 'u')).map((device) => device.device_id)).toEqual(['phone-ready'])
    const all = await listDevices(client, 'u', { includePhones: true })
    expect(all.map(isAgentHostDevice)).toEqual([true, false, false])
  })
})

describe('安装标识', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      get length() { return store.size },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('无原生绑定的旧标识不能证明来自这台手机;验证后标识保持不变', () => {
    store.set('gugu.phoneDevice.install', 'old-install')
    const verified = phoneInstallId('key-a', 'registration-key-a')
    expect(verified).not.toBe('old-install')
    expect(phoneInstallId('key-a', 'registration-key-a')).toBe(verified)
  })

  it('从别的手机的备份里恢复来的(install_key 对不上)⇒ 换一个,❌ 两台手机共用一个设备行', () => {
    const first = phoneInstallId('key-a', 'registration-key-a')
    expect(phoneInstallId('key-a', 'registration-key-a')).toBe(first)
    const restored = phoneInstallId('key-b', 'registration-key-b')
    expect(restored).not.toBe(first)
    expect(phoneInstallId('key-b', 'registration-key-b')).toBe(restored)
  })
})

describe('设置页:这一组还缺什么', () => {
  it('只列「去授权」补得上的;时钟 App 不在其中', () => {
    expect(missingRequirements('notifications', osState({ dnd_access: false }))).toEqual(['dnd_access'])
    expect(missingRequirements('alarm', osState({ alarm_app: false }))).toEqual([])
    expect(missingRequirements('calendar', null)).toEqual([])
  })
})

describe('「后台守着」常驻通知两家共用', () => {
  beforeEach(() => platformMock.setBackgroundWatch.mockClear())

  it('两句都在时并排写,看管机器在前', () => {
    expect(backgroundWatchLabel(new Map([['phoneDevice', { label: 'B' }], ['agentWatch', { label: 'A' }]]))).toBe('A · B')
    expect(backgroundWatchLabel(new Map())).toBeNull()
  })

  it('一家放手不关掉另一家;最后一个放手才关', () => {
    const releaseWatch = claimBackgroundWatch('agentWatch', '咕咕正在看管 1 台机器')
    const releasePhone = claimBackgroundWatch('phoneDevice', '助理可以用这台手机')
    releaseWatch()
    expect(platformMock.setBackgroundWatch).toHaveBeenLastCalledWith('助理可以用这台手机', undefined)
    releasePhone()
    expect(platformMock.setBackgroundWatch).toHaveBeenLastCalledWith(null, undefined)
  })

  it('同一家改字:旧的放手是空操作,❌ 把新的关掉', () => {
    const releaseOld = claimBackgroundWatch('phoneDevice', '助理可以用这台手机', '切到后台，助理也能调这台手机')
    const releaseNew = claimBackgroundWatch('phoneDevice', '云端助理正在调用:查日程', '切到后台，助理也能调这台手机')
    releaseOld()
    expect(platformMock.setBackgroundWatch).toHaveBeenLastCalledWith('云端助理正在调用:查日程', '切到后台，助理也能调这台手机')
    releaseNew()
  })

  it('正文:只有手机当设备时用它自己那句;看管机器也在时用看管那句(宿主默认)', () => {
    expect(backgroundWatchText(new Map([['phoneDevice', { label: 'B', text: '手机那句' }]]))).toBe('手机那句')
    expect(backgroundWatchText(new Map([['agentWatch', { label: 'A' }], ['phoneDevice', { label: 'B', text: '手机那句' }]]))).toBeUndefined()
  })
})
