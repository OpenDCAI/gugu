// @vitest-environment jsdom
import { expectExit, frame, holdDialogExit } from '../../support/dialogExit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneVoiceBar } from '../../../apps/desktop/src/mobile/assistant/PhoneVoiceBar'
import type { VoiceJobView } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceJobs'
import type { RecorderSnapshot } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceRecorder'
import { clickElement, createNode, createReactHarness } from '../../support/testHarness'

// #7199 手机录音条:录着有放弃 / 暂停 / 结束;有录音在等、它住的云端宿主收回着时系统自己叫起来、说「正在连接」
// (owner 10-17 ❌「在休息 / 叫醒它」),叫不起来说原因 + 重试;没给麦克风说怎么开并给去设置的钮。
// 录音机 / 进度 / 叫醒都是假的(只看条子按状态画什么、叫了谁几次)。

const mocks = vi.hoisted(() => ({
  recorder: { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null } as unknown as RecorderSnapshot,
  jobs: [] as VoiceJobView[],
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  clearError: vi.fn(),
  discard: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
  openSettings: vi.fn(async () => undefined),
  wake: vi.fn(async () => undefined),
}))

vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceRuntime', () => ({
  useRecorder: () => mocks.recorder,
  useVoiceJobs: () => mocks.jobs,
  openMicrophoneSettings: mocks.openSettings,
  phoneVoiceRecorder: { stop: mocks.stop, pause: mocks.pause, resume: mocks.resume, cancel: mocks.cancel, clearError: mocks.clearError },
  phoneVoiceJobs: { discard: mocks.discard, retry: mocks.retry, dismiss: mocks.dismiss },
}))
vi.mock('../../../apps/desktop/src/lib/cloudComputerStore', () => ({ wakeCloudComputer: mocks.wake }))

const job = (extra: Partial<VoiceJobView> = {}): VoiceJobView => ({ id: 'note-1', phase: 'recording', failure: null, dismissed: false, createdAt: '2026-10-16T09:00:00.000Z', held: null, ...extra })
const voice = (extra: Partial<{ micDenied: boolean }> = {}) => ({ start: vi.fn(), disabled: false, micDenied: false, clearMicDenied: vi.fn(), ...extra })
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.recorder = { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null } as unknown as RecorderSnapshot
  mocks.jobs = []
  for (const fn of [mocks.stop, mocks.pause, mocks.resume, mocks.cancel, mocks.clearError, mocks.discard, mocks.retry, mocks.dismiss, mocks.openSettings, mocks.wake]) fn.mockClear()
})
afterEach(() => { harness.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })

const render = (v = voice()) => harness.render(createNode(PhoneVoiceBar, { voice: v, name: '小咕', column: null, onChat: true, open: vi.fn() }))

describe('录着', () => {
  it('计时、暂停、结束;放弃先问一句,确认了才丢(丢的是正在录的那一条)', async () => {
    const exit = holdDialogExit()
    mocks.recorder = { phase: 'recording', elapsedMs: 65_000, level: 0.4, silentMs: 0, error: null } as unknown as RecorderSnapshot
    mocks.jobs = [job()]
    await render()
    expect(q('phone-voice-bar')?.getAttribute('data-phase')).toBe('recording')
    expect(q('phone-voice-bar-clock')?.textContent).toBe('00:01:05')

    await clickElement(q('phone-voice-bar-pause')!)
    expect(mocks.pause).toHaveBeenCalledTimes(1)
    await clickElement(q('phone-voice-bar-stop')!)
    expect(mocks.stop).toHaveBeenCalledTimes(1)

    await clickElement(q('phone-voice-bar-discard')!)
    await frame()
    const popup = q('phone-voice-discard')!
    expect(mocks.discard).not.toHaveBeenCalled()
    await clickElement(q('phone-voice-discard-confirm')!)
    expect(mocks.discard).toHaveBeenCalledWith('note-1')
    await expectExit(popup, exit)
  })

  it('连着 8 秒以上没声音:波形换成「未检测到声音」', async () => {
    mocks.recorder = { phase: 'recording', elapsedMs: 20_000, level: 0, silentMs: 9_000, error: null } as unknown as RecorderSnapshot
    mocks.jobs = [job()]
    await render()
    expect(q('phone-voice-bar-nosound')).not.toBeNull()
    expect(document.querySelector('.vn-wave')).toBeNull()
  })

  it('暂停时:按钮变「继续」,点了叫继续', async () => {
    mocks.recorder = { phase: 'paused', elapsedMs: 5_000, level: 0, silentMs: 0, error: null } as unknown as RecorderSnapshot
    mocks.jobs = [job()]
    await render()
    await clickElement(q('phone-voice-bar-pause')!)
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    expect(mocks.pause).not.toHaveBeenCalled()
  })
})

describe('系统没给麦克风', () => {
  it('条子上说怎么开,有「去系统设置」;关掉就收起', async () => {
    const v = voice({ micDenied: true })
    await render(v)
    expect(q('phone-voice-bar-denied')).not.toBeNull()
    await clickElement(q('phone-voice-bar-settings')!)
    expect(mocks.openSettings).toHaveBeenCalledTimes(1)
  })

  it('没有这件事、也没有进度:条子不画(❌ 空条)', async () => {
    await render()
    expect(q('phone-voice-bar')).toBeNull()
  })
})

describe('有录音在等它家里:系统连它,录音先存在手机上', () => {
  it('宿主收回着:渲染即叫一次(同一条不重复叫),说「正在连接」,没有「叫醒它」也没有「休息」', async () => {
    mocks.jobs = [job({ phase: 'uploading', held: 'asleep' })]
    await render()
    expect(q('phone-voice-bar-held')?.getAttribute('data-held')).toBe('asleep')
    expect(q('phone-voice-bar-held')?.textContent).toContain('正在连接')
    expect(q('phone-voice-bar-held')?.textContent).not.toMatch(/休息|叫醒/)
    expect(mocks.wake).toHaveBeenCalledTimes(1)
    await render()
    expect(mocks.wake).toHaveBeenCalledTimes(1)
    expect(q('phone-voice-bar-wake')).toBeNull()
  })

  it('叫不起来:说原因、录音还在手机上,给重试;点重试再叫一次', async () => {
    mocks.wake.mockRejectedValueOnce(new Error('boom'))
    mocks.jobs = [job({ phase: 'uploading', held: 'asleep' })]
    await render()
    await vi.waitFor(() => expect(q('phone-voice-bar-held')?.getAttribute('data-held')).toBe('connect-failed'))
    expect(q('phone-voice-bar-held')?.textContent).toContain('录音先存在手机上')
    await clickElement(q('phone-voice-bar-retry-connect')!)
    expect(mocks.wake).toHaveBeenCalledTimes(2)
  })

  it('正在起来 / 连不上:只说,不叫、不给钮', async () => {
    mocks.jobs = [job({ phase: 'uploading', held: 'waking' })]
    await render()
    expect(q('phone-voice-bar-held')?.getAttribute('data-held')).toBe('waking')
    expect(q('phone-voice-bar-held')?.textContent).toContain('正在连接')
    mocks.jobs = [job({ phase: 'uploading', held: 'unreachable' })]
    await render()
    expect(q('phone-voice-bar-held')?.getAttribute('data-held')).toBe('unreachable')
    expect(mocks.wake).not.toHaveBeenCalled()
    expect(q('phone-voice-bar-retry-connect')).toBeNull()
  })
})

describe('失败与处理中', () => {
  it('失败:说是哪一步,有「重试」', async () => {
    mocks.jobs = [job({ phase: 'failed', failure: { stage: 'upload', message: 'offline', retryable: true } })]
    await render()
    expect(q('phone-voice-bar-failed')).not.toBeNull()
    await clickElement(q('phone-voice-bar-retry')!)
    expect(mocks.retry).toHaveBeenCalledWith('note-1')
  })

  it('传上去了:终点就是「已传到它家里,等转写」,点条子去那一条笔记(并收起条子);❌ 出现转写 / 总结的进度', async () => {
    mocks.jobs = [job({ phase: 'uploaded' })]
    const open = vi.fn()
    await harness.render(createNode(PhoneVoiceBar, { voice: voice(), name: '小咕', column: null, onChat: true, open }))
    expect(q('phone-voice-bar-open')?.getAttribute('data-phase')).toBe('uploaded')
    expect(q('loading-indicator')).toBeNull()
    await clickElement(q('phone-voice-bar-open')!)
    expect(open).toHaveBeenCalledWith({ tab: 'memory', sub: 'voice:note-1' })
    expect(mocks.dismiss).toHaveBeenCalledWith('note-1')
  })

  it('正在传:转圈 + 点了也能去那一条', async () => {
    mocks.jobs = [job({ phase: 'uploading' })]
    await render()
    expect(q('phone-voice-bar-open')?.getAttribute('data-phase')).toBe('uploading')
    expect(q('loading-indicator')).not.toBeNull()
  })
})
