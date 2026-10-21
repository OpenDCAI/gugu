// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// product spec (#5693) — the Android adapter must report the system's own permission
// state, route each row to "ask" or "open system settings", and post notifications without ever
// bouncing the user into the exact-alarm settings screen. Native plugins are mocked; the adapter
// logic runs in jsdom.

const mocks = vi.hoisted(() => ({
  notificationsCheck: vi.fn(),
  notificationsRequest: vi.fn(),
  createChannel: vi.fn(),
  schedule: vi.fn(),
  cameraCheck: vi.fn(),
  cameraRequest: vi.fn(),
  openSettings: vi.fn(),
  batteryCheck: vi.fn(),
  batteryRequest: vi.fn(),
  bgEnable: vi.fn(),
  bgUpdate: vi.fn(),
  bgDisable: vi.fn(),
}))

vi.mock('@anuradev/capacitor-background-mode', () => ({
  BackgroundMode: {
    checkBatteryOptimizations: mocks.batteryCheck,
    requestDisableBatteryOptimizations: mocks.batteryRequest,
    enable: mocks.bgEnable,
    updateNotification: mocks.bgUpdate,
    disable: mocks.bgDisable,
  },
}))

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: mocks.notificationsCheck,
    requestPermissions: mocks.notificationsRequest,
    createChannel: mocks.createChannel,
    schedule: mocks.schedule,
  },
}))
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeFormat: { QrCode: 'QR_CODE' },
  BarcodeScanner: { checkPermissions: mocks.cameraCheck, requestPermissions: mocks.cameraRequest },
}))
vi.mock('capacitor-native-settings', () => ({
  AndroidSettings: {
    AppNotification: 'app_notification',
    ApplicationDetails: 'application_details',
    BatteryOptimization: 'battery_optimization',
  },
  IOSSettings: { App: 'App' },
  NativeSettings: { open: mocks.openSettings },
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn() } }))

import { capacitorPlatform, toSystemPermissionState } from '../../../../apps/desktop/src/platform/capacitor'
import { desktopSystemPermissions, electronPlatform } from '../../../../apps/desktop/src/platform/electron'
import { webPlatform } from '../../../../apps/desktop/src/platform/web'
import { systemPermissionAction } from '../../../../apps/desktop/src/lib/systemPermissions'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.createChannel.mockResolvedValue(undefined)
  mocks.schedule.mockResolvedValue({ notifications: [] })
})

describe('system permission state mapping', () => {
  it('treats only the plugin\'s "denied" as blocked — the state where the system will not show a dialog again', () => {
    expect(toSystemPermissionState('granted')).toBe('granted')
    expect(toSystemPermissionState('limited')).toBe('granted')
    expect(toSystemPermissionState('prompt')).toBe('prompt')
    expect(toSystemPermissionState('prompt-with-rationale')).toBe('prompt')
    expect(toSystemPermissionState('denied')).toBe('blocked')
  })

  it('never leaves a row without an action: ask while the system still asks, otherwise open system settings', () => {
    expect(systemPermissionAction('prompt')).toBe('request')
    expect(systemPermissionAction('blocked')).toBe('open-settings')
    expect(systemPermissionAction('granted')).toBe('open-settings')
  })

  it('reads each permission from its own plugin', async () => {
    mocks.notificationsCheck.mockResolvedValue({ display: 'prompt-with-rationale' })
    mocks.cameraCheck.mockResolvedValue({ camera: 'denied' })
    await expect(capacitorPlatform.checkSystemPermission('notifications')).resolves.toBe('prompt')
    await expect(capacitorPlatform.checkSystemPermission('camera')).resolves.toBe('blocked')
  })

  it('returns the state after the system dialog', async () => {
    mocks.notificationsRequest.mockResolvedValue({ display: 'granted' })
    mocks.cameraRequest.mockResolvedValue({ camera: 'prompt-with-rationale' })
    await expect(capacitorPlatform.requestSystemPermission('notifications')).resolves.toBe('granted')
    await expect(capacitorPlatform.requestSystemPermission('camera')).resolves.toBe('prompt')
  })
})

describe('capacitor showNotification', () => {
  it('reports "not shown" without posting or prompting when the system has not granted notifications', async () => {
    mocks.notificationsCheck.mockResolvedValue({ display: 'denied' })
    const result = await capacitorPlatform.showNotification({ title: 'agent finished' })
    expect(result).toMatchObject({ displayed: false, error: 'NOTIFICATIONS_NOT_GRANTED' })
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(mocks.createChannel).not.toHaveBeenCalled()
    expect(mocks.notificationsRequest).not.toHaveBeenCalled()
  })

  it('posts immediately, never as an exact alarm, on the sound or quiet channel; channels are created once', async () => {
    mocks.notificationsCheck.mockResolvedValue({ display: 'granted' })

    await expect(capacitorPlatform.showNotification({ title: 'agent finished', body: 'done', chatId: 'chat-1' }))
      .resolves.toMatchObject({ displayed: true })
    await capacitorPlatform.showNotification({ title: 'new message', silent: true })

    expect(mocks.createChannel).toHaveBeenCalledTimes(2)
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'gugu-alerts', importance: 4 }))
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'gugu-alerts-quiet', importance: 2 }))

    const [loud] = mocks.schedule.mock.calls[0][0].notifications
    const [quiet] = mocks.schedule.mock.calls[1][0].notifications
    expect(loud).toMatchObject({
      title: 'agent finished',
      body: 'done',
      channelId: 'gugu-alerts',
      isExactNotification: false,
      extra: { chatId: 'chat-1' },
    })
    expect(loud.schedule).toBeUndefined()
    expect(quiet).toMatchObject({ channelId: 'gugu-alerts-quiet', isExactNotification: false, body: '' })
    expect(quiet.id).not.toBe(loud.id)
  })
})

describe('capacitor openSystemPermissionSettings', () => {
  it('opens the app notification page for notifications and app details for the camera', async () => {
    mocks.openSettings.mockResolvedValue({ status: true })
    await expect(capacitorPlatform.openSystemPermissionSettings('notifications')).resolves.toBe(true)
    await expect(capacitorPlatform.openSystemPermissionSettings('camera')).resolves.toBe(true)
    expect(mocks.openSettings.mock.calls[0][0]).toMatchObject({ optionAndroid: 'app_notification' })
    expect(mocks.openSettings.mock.calls[1][0]).toMatchObject({ optionAndroid: 'application_details' })
  })

  it('passes a failed jump back so the page can say where to go instead', async () => {
    mocks.openSettings.mockResolvedValue({ status: false })
    await expect(capacitorPlatform.openSystemPermissionSettings('camera')).resolves.toBe(false)
  })
})

/**
 * product spec 的「后台守着」。实测过的事实:安卓把咕咕切到后台之后 5 秒就断了它的网,
 * 约一分钟后连页面里的定时器都冻住 —— 所以这个开关开没开,决定了「切后台还能不能收到提醒」。
 */
describe('background watch', () => {
  beforeEach(async () => {
    mocks.bgEnable.mockResolvedValue(undefined)
    mocks.bgUpdate.mockResolvedValue(undefined)
    mocks.bgDisable.mockResolvedValue(undefined)
    // 适配器里的「已经生效的状态」是模块级的,跨用例会串 —— 每条用例先归零再数调用次数。
    await capacitorPlatform.setBackgroundWatch(null)
    mocks.bgEnable.mockClear()
    mocks.bgUpdate.mockClear()
    mocks.bgDisable.mockClear()
  })

  it('starts once, then only rewrites the notification text, and stops on null', async () => {
    await capacitorPlatform.setBackgroundWatch('咕咕正在看管 1 台机器')
    expect(mocks.bgEnable).toHaveBeenCalledTimes(1)
    expect(mocks.bgEnable.mock.calls[0][0]).toMatchObject({
      title: '咕咕正在看管 1 台机器',
      silent: true,
      // 后台时告诉 WebView「你还看得见」,否则 Chromium 把页面里的定时器冻掉,保活就断了。
      disableWebViewOptimization: true,
      // 小图标与着色都跟别的咕咕通知同一套 —— 不给的话是插件自带的图形与它自己的绿。
      icon: 'ic_stat_gugu',
      color: '07C160',
    })
    /*
     * 正文与图标都必须**我们自己**给。2026-09-16 实测:只给标题时,模拟器通知栏里第二行显示的是
     * 插件自带的默认句 "App will start faster" —— 一句英文,讲的还是它作者关心的事。
     * 这条钉的就是那个默认值不许再漏出来。
     */
    const settings = mocks.bgEnable.mock.calls[0][0] as { text?: string }
    expect(settings.text, '常驻通知第二行不能留给插件的默认值').toBeTruthy()
    expect(settings.text).not.toMatch(/[A-Za-z]{4,}/)

    // 台数变了只改字 —— ❌ 关了再开:那会断一次连接,还让常驻通知闪一下。
    await capacitorPlatform.setBackgroundWatch('咕咕正在看管 2 台机器')
    expect(mocks.bgEnable).toHaveBeenCalledTimes(1)
    expect(mocks.bgUpdate).toHaveBeenCalledTimes(1)

    await capacitorPlatform.setBackgroundWatch(null)
    expect(mocks.bgDisable).toHaveBeenCalledTimes(1)
  })

  /*
   * 这条钉的是一次**实测抓到的真 bug**:React 的 effect 重挂会在同一拍里先清理、再 setup,
   * 于是同一毫秒内先后要求「关掉」和「开着」。两条都是异步派发给原生层,谁后落地不保证 ——
   * 2026-09-16 实测 logcat 里 disable(00:45:07.979) 落在 enable(.984) 之后,前台服务被关掉,
   * 一分钟后安卓把整个进程冻了(`freezing … app.gugu.chat`),那一轮提醒彻底没到,
   * 而且这件事在产品里没有任何地方显形。
   */
  it('survives an effect remount: a same-tick off/on pair must not reach the plugin at all', async () => {
    await capacitorPlatform.setBackgroundWatch('咕咕正在看管 1 台机器')
    expect(mocks.bgEnable).toHaveBeenCalledTimes(1)

    // 清理与 setup 同一拍发出,❌ 不 await 中间那一个 —— 真实调用点就是这样。
    const off = capacitorPlatform.setBackgroundWatch(null)
    const on = capacitorPlatform.setBackgroundWatch('咕咕正在看管 1 台机器')
    await Promise.all([off, on])

    expect(mocks.bgDisable).not.toHaveBeenCalled()
    expect(mocks.bgEnable).toHaveBeenCalledTimes(1)
    expect(mocks.bgUpdate).not.toHaveBeenCalled()
  })

  it('still ends up off when off is the last word', async () => {
    await capacitorPlatform.setBackgroundWatch('咕咕正在看管 1 台机器')
    const a = capacitorPlatform.setBackgroundWatch('咕咕正在看管 2 台机器')
    const b = capacitorPlatform.setBackgroundWatch(null)
    await Promise.all([a, b])
    expect(mocks.bgDisable).toHaveBeenCalledTimes(1)
    // 中间那个「2 台」是过路状态,人从来没看到过 —— ❌ 不必为它发一次原生调用。
    expect(mocks.bgUpdate).not.toHaveBeenCalled()
  })

  it('reads the battery row the way the user means it: not being optimized is what counts as on', async () => {
    mocks.batteryCheck.mockResolvedValue({ enabled: true })
    await expect(capacitorPlatform.checkSystemPermission('batteryOptimization')).resolves.toBe('prompt')
    mocks.batteryCheck.mockResolvedValue({ enabled: false })
    await expect(capacitorPlatform.checkSystemPermission('batteryOptimization')).resolves.toBe('granted')
    // 系统那个确认框可以反复弹,所以这一行永远点得动 —— ❌ 不会退化成 blocked 的死按钮。
    expect(systemPermissionAction('prompt')).toBe('request')
  })
})

describe('capability gate', () => {
  it('each host reports the rows it can serve; unreadable is said out loud, never invented', async () => {
    expect(capacitorPlatform.systemPermissions).toEqual(['notifications', 'camera', 'batteryOptimization'])
    expect(capacitorPlatform.capabilities.notifications).toBe(true)
    expect(webPlatform.systemPermissions).toEqual([])
    // 桌面按「这个系统有没有那一页可跳」决定列哪几行;状态读不到写「查不到」,不是不列的理由。
    expect(desktopSystemPermissions('mac')).toEqual(['notifications', 'fileAccess'])
    expect(desktopSystemPermissions('win')).toEqual(['notifications'])
    expect(desktopSystemPermissions('linux')).toEqual([])
    await expect(electronPlatform.checkSystemPermission('notifications')).resolves.toBe('unreadable')
    await expect(webPlatform.checkSystemPermission('notifications')).rejects.toThrow()
  })
})
