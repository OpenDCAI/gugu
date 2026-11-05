// #7199 语音笔记的主进程那一半:以个人助理的名义签平台票转写一段录音(网关明说不给 = 那句话给人看、不重试;5xx / 断网 / 限流
// 再试一次;票失效换一张;一条笔记的几段共用一张票,用着的票不结),会议提醒读这台电脑的日历只回提醒用得上的几样。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const issuePlatformModelAccess = vi.fn()
const revokePlatformModelAccess = vi.fn(async (..._args: unknown[]) => undefined)
const fetchMock = vi.fn()

vi.mock('electron', () => ({ app: { isPackaged: true }, net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))
vi.mock('../../../../apps/desktop/electron/model-access', () => ({
  issuePlatformModelAccess: (...args: unknown[]) => issuePlatformModelAccess(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  modelAccessFailureReason: () => 'membership-required',
}))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { release, transcribeVoiceNoteSegment, upcomingMeetings } = await import('../../../../apps/desktop/electron/voice-notes')

const auth = {} as never
const request = { agentUserId: 'assistant-1', audioBase64: 'UklGRg==', prompt: '逐字转写' }

function ticket(id = 'access-1') {
  return { accessSessionId: id, relayUrl: 'https://relay.test', token: 'tok', model: 'gemini-3.8-flash', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  issuePlatformModelAccess.mockReset().mockResolvedValue(ticket())
  revokePlatformModelAccess.mockClear()
  fetchMock.mockReset()
})
afterEach(async () => {
  await release(auth, request.agentUserId)
  vi.useRealTimers()
})

describe('转写一段', () => {
  it('以助理的名义签票(语音笔记那个模型),把 WAV 当 input_audio 交上去,回模型说的字', async () => {
    fetchMock.mockResolvedValue(reply(200, { choices: [{ message: { content: '[00:01] 说话人1：你好' } }] }))
    await expect(transcribeVoiceNoteSegment(auth, request)).resolves.toEqual({ ok: true, text: '[00:01] 说话人1：你好' })
    expect(issuePlatformModelAccess).toHaveBeenCalledWith(expect.objectContaining({ agentUserId: 'assistant-1', modelId: 'gemini-3.8-flash', protocol: 'openai-chat-completions' }))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    const body = JSON.parse(String(init.body))
    expect(body.messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } })
  })

  it('一条笔记的几段共用一张票;叫 release 才结', async () => {
    fetchMock.mockResolvedValue(reply(200, { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }))
    await expect(transcribeVoiceNoteSegment(auth, request)).resolves.toEqual({ ok: true, text: 'ab' })
    await transcribeVoiceNoteSegment(auth, request)
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    await release(auth, request.agentUserId)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(auth, 'access-1')
  })

  it('网关明说不给(402 / 403):那句话原样带回给人看,不重试', async () => {
    fetchMock.mockResolvedValue(reply(402, { error: { message: '积分不足，请充值' } }))
    await expect(transcribeVoiceNoteSegment(auth, request)).resolves.toEqual({ ok: false, code: 'refused', message: '积分不足，请充值' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('别的 4xx(请求太大、格式不对)是咕咕这边的事:不当成给人看的话,不重试', async () => {
    fetchMock.mockResolvedValue(reply(413, { error: { message: 'request entity too large' } }))
    const result = await transcribeVoiceNoteSegment(auth, request)
    expect(result).toMatchObject({ ok: false, code: 'failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('票被网关拒了(401):结掉旧的、换一张再试一次', async () => {
    issuePlatformModelAccess.mockResolvedValueOnce(ticket('access-1')).mockResolvedValueOnce(ticket('access-2'))
    fetchMock.mockResolvedValueOnce(reply(401, { error: { message: 'invalid token' } })).mockResolvedValueOnce(reply(200, { choices: [{ message: { content: 'ok' } }] }))
    await expect(transcribeVoiceNoteSegment(auth, request)).resolves.toEqual({ ok: true, text: 'ok' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(2)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(auth, 'access-1')
  })

  it('另一条笔记正用着这张票时叫了结:等它用完再结', async () => {
    let answer: (value: unknown) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const inFlight = transcribeVoiceNoteSegment(auth, request)
    await vi.advanceTimersByTimeAsync(0)
    await release(auth, request.agentUserId)
    expect(revokePlatformModelAccess).not.toHaveBeenCalled()
    answer(reply(200, { choices: [{ message: { content: 'ok' } }] }))
    await expect(inFlight).resolves.toEqual({ ok: true, text: 'ok' })
    await vi.advanceTimersByTimeAsync(0)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(auth, 'access-1')
  })

  it('5xx / 限流 / 请求没回来:再试一次', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(reply(200, { choices: [{ message: { content: 'ok' } }] }))
    const result = transcribeVoiceNoteSegment(auth, request)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toEqual({ ok: true, text: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('签不到票:按签票失败的原因回(界面据此说下一步)', async () => {
    issuePlatformModelAccess.mockRejectedValue(new Error('membership required'))
    await expect(transcribeVoiceNoteSegment(auth, request)).resolves.toMatchObject({ ok: false, code: 'membership-required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('闲着 3 分钟票自己结掉', async () => {
    fetchMock.mockResolvedValue(reply(200, { choices: [{ message: { content: 'ok' } }] }))
    await transcribeVoiceNoteSegment(auth, request)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(auth, 'access-1')
  })
})

describe('会议提醒读日历', () => {
  it('问前 5 分钟到后 15 分钟开始的日程,只回 id / 标题 / 起止 / 全天', async () => {
    const now = Date.parse('2026-10-15T10:00:00.000Z')
    const readCalendar = vi.fn(async () => ({
      ok: true as const,
      data: { events: [{ event_id: 'e1', title: '周会', start: '2026-10-15T10:05:00Z', end: '2026-10-15T11:00:00Z', all_day: false, notes: '不该带出去' }, { title: '没有 id' }] },
    }))
    await expect(upcomingMeetings(readCalendar, now)).resolves.toEqual({
      ok: true,
      meetings: [{ id: 'e1', title: '周会', start: '2026-10-15T10:05:00Z', end: '2026-10-15T11:00:00Z', allDay: false }],
    })
    expect(readCalendar).toHaveBeenCalledWith({ start: '2026-10-15T09:55:00.000Z', end: '2026-10-15T10:15:00.000Z', limit: 20 })
  })

  it('读不了(没授权 / 出错)回原因码', async () => {
    await expect(upcomingMeetings(async () => ({ ok: false, code: 'not_permitted', message: 'x' }))).resolves.toEqual({ ok: false, code: 'not_permitted' })
    await expect(upcomingMeetings(async () => { throw new Error('boom') })).resolves.toEqual({ ok: false, code: 'execution_failed' })
  })
})
