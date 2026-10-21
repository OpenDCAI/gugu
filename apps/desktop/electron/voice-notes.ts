/**
 * #7199 语音笔记的转写:主进程以个人助理的名义签一张平台票(与它开会话同一个签发口 `model-access issue`,
 * 账单按积分记在它名下),把一段 16k 单声道 WAV 交给会听录音的那个模型(Chat Completions + input_audio),
 * 回模型说的那段字。渲染层够不到凭据 —— 它只交音频与提示(格式与切段在 @gugu/core/shared/voiceNotes)。
 *
 * 一条笔记往往要转好几段:票按助理缓存,快过期才换;一条转写完由渲染层叫 release 结掉,忘了叫也会在闲置几分钟后自己结。
 * 应用退出时没结的票由平台票账本统一结清(model-access 的 ledger),这里 ❌ 另记一份。
 */
import * as electron from 'electron'
import type { RuntimeAuthProvider } from '@gugu/core'
import {
  issuePlatformModelAccess,
  modelAccessFailureReason,
  revokePlatformModelAccess,
  type IssuedModelAccess,
} from './model-access'
import { createLogger } from './lib/logger'
import {
  VOICE_NOTE_MODEL_ID,
  VOICE_NOTE_MODEL_PROTOCOL,
  type VoiceNoteMeetingsResult,
  type VoiceNoteMicrophoneAction,
  type VoiceNoteMicrophoneStatus,
  type VoiceNoteTranscribeRequest,
  type VoiceNoteTranscribeResult,
} from '../src/session/shared/core/voice-notes'

const log = createLogger('voice-notes')

/** 签票时报的「引擎」:不是哪个 harness,只是账本上认得出这张票是语音笔记签的。 */
const VOICE_NOTE_ENGINE_ID = 'gugu-voice-notes'
/** 一段 5 分钟的录音,模型实测 10–40 秒;给足余量,超过就当这一轮失败(可重试)。 */
const TRANSCRIBE_TIMEOUT_MS = 4 * 60_000
/** 票还剩不到这么久就换一张(一段转写最长要这么久)。 */
const TICKET_MARGIN_MS = TRANSCRIBE_TIMEOUT_MS + 30_000
/** 闲置这么久就把票结掉。 */
const TICKET_IDLE_MS = 3 * 60_000

/** retired = 已经不归这个助理用了(换了新票 / 叫了结),等手上那几段转完再结,❌ 在用着的时候结掉。 */
type Held = { access: IssuedModelAccess; idle: ReturnType<typeof setTimeout> | null; busy: number; retired: boolean }

const held = new Map<string, Held>()
const issuing = new Map<string, Promise<Held>>()

function netFetch(url: string, init: RequestInit): Promise<Response> {
  const fetcher = (electron as { net?: { fetch?: typeof fetch } } | undefined)?.net?.fetch
  return fetcher ? fetcher(url, init) : fetch(url, init)
}

async function ticketFor(authProvider: RuntimeAuthProvider, agentUserId: string): Promise<Held> {
  const current = held.get(agentUserId)
  if (current && Date.parse(current.access.expiresAt) - Date.now() > TICKET_MARGIN_MS) return current
  const pending = issuing.get(agentUserId)
  if (pending) return pending
  const next = (async () => {
    if (current) retire(authProvider, current)
    const access = await issuePlatformModelAccess({
      authProvider,
      agentUserId,
      engineId: VOICE_NOTE_ENGINE_ID,
      modelId: VOICE_NOTE_MODEL_ID,
      protocol: VOICE_NOTE_MODEL_PROTOCOL,
    })
    const entry: Held = { access, idle: null, busy: 0, retired: false }
    held.set(agentUserId, entry)
    return entry
  })()
  issuing.set(agentUserId, next)
  try {
    return await next
  } finally {
    issuing.delete(agentUserId)
  }
}

function armIdle(authProvider: RuntimeAuthProvider, agentUserId: string, entry: Held): void {
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = setTimeout(() => {
    if (held.get(agentUserId) === entry && entry.busy === 0) void release(authProvider, agentUserId)
  }, TICKET_IDLE_MS)
}

/** 把为这个助理签的票结掉(一条笔记转写完 / 闲置)。没有就什么也不做;别的笔记正用着就等它用完再结。 */
export async function release(authProvider: RuntimeAuthProvider, agentUserId: string): Promise<void> {
  const entry = held.get(agentUserId)
  if (!entry) return
  await retire(authProvider, entry)
}

async function retire(authProvider: RuntimeAuthProvider, entry: Held): Promise<void> {
  for (const [agent, current] of held) if (current === entry) held.delete(agent)
  if (entry.idle) clearTimeout(entry.idle)
  entry.retired = true
  if (entry.busy > 0) return
  await revokePlatformModelAccess(authProvider, entry.access.accessSessionId).catch((error: unknown) => {
    log.warn({ err: error, accessSessionId: entry.access.accessSessionId }, '语音笔记的平台票没结掉;退出时账本会再结一次')
  })
}

/** 模型回的 content:字符串,或 [{type:'text', text}] 一串。 */
function contentText(payload: unknown): string | null {
  const choice = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
  return null
}

function gatewayMessage(payload: unknown, status: number): string {
  const error = (payload as { error?: unknown } | null)?.error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
  if (typeof error === 'string') return error
  return `HTTP ${status}`
}

/** 网关明说「不给」、那句话是给人看的(积分用完、额度 / 分组不对)。别的 4xx(请求太大、格式不对)是咕咕这边的事,❌ 原话给人看。 */
const SPOKEN_REFUSALS = new Set([402, 403])
/** 这一轮没跑成,换一轮可能就好(超时、限流、上游 5xx)。 */
const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500

type ModelReply = VoiceNoteTranscribeResult | { ok: false; code: 'ticket-expired' | 'retry'; message: string }

async function callModel(access: IssuedModelAccess, request: VoiceNoteTranscribeRequest): Promise<ModelReply> {
  const response = await netFetch(`${access.relayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({
      model: access.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            { type: 'input_audio', input_audio: { data: request.audioBase64, format: 'wav' } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })
  const payload = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const message = gatewayMessage(payload, response.status)
    if (response.status === 401) return { ok: false, code: 'ticket-expired', message }
    if (SPOKEN_REFUSALS.has(response.status)) return { ok: false, code: 'refused', message }
    return { ok: false, code: RETRYABLE(response.status) ? 'retry' : 'failed', message: `HTTP ${response.status}: ${message}` }
  }
  const text = contentText(payload)
  if (text === null) return { ok: false, code: 'failed', message: 'model returned no content' }
  return { ok: true, text }
}

export async function transcribeVoiceNoteSegment(
  authProvider: RuntimeAuthProvider,
  request: VoiceNoteTranscribeRequest,
): Promise<VoiceNoteTranscribeResult> {
  // 网络断一下 / 限流 / 上游 5xx 再试一次;票失效(401)换一张再试一次;网关明说不给不重试。
  let retried = false
  let reissued = false
  for (;;) {
    let entry: Held
    try {
      entry = await ticketFor(authProvider, request.agentUserId)
    } catch (error) {
      const code = modelAccessFailureReason(error)
      log.warn({ err: error, code }, '语音笔记签票失败')
      return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
    }
    entry.busy += 1
    let reply: ModelReply
    try {
      reply = await callModel(entry.access, request).catch((error: unknown): ModelReply => ({ ok: false, code: 'retry', message: error instanceof Error ? error.message : String(error) }))
    } finally {
      entry.busy -= 1
      if (entry.retired) {
        if (entry.busy === 0) void retire(authProvider, entry)
      } else armIdle(authProvider, request.agentUserId, entry)
    }
    if (reply.ok || reply.code === 'refused' || reply.code === 'failed') return reply
    if (reply.code === 'ticket-expired' && !reissued) {
      reissued = true
      log.warn({ message: reply.message }, '语音笔记的平台票被网关拒了,换一张再试')
      void retire(authProvider, entry)
      continue
    }
    if (reply.code === 'retry' && !retried) {
      retried = true
      log.warn({ message: reply.message }, '语音笔记转写这一轮没跑成,再试一次')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      continue
    }
    return { ok: false, code: 'failed', message: reply.message }
  }
}

/** 麦克风:macOS 第一次问会弹系统授权框;拒过就只能去系统设置里开。 */
export async function voiceNoteMicrophone(action: VoiceNoteMicrophoneAction): Promise<VoiceNoteMicrophoneStatus> {
  const { systemPreferences, shell } = electron
  if (action === 'open-settings') {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    else if (process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone')
    return 'unsupported'
  }
  // 冒充的麦克风(main.ts 的 GUGU_FAKE_MICROPHONE_FILE,装机包不认)不经系统授权。
  if (process.env.GUGU_FAKE_MICROPHONE_FILE?.trim() && !electron.app.isPackaged) return 'granted'
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return 'granted'
    if (status === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
    return 'denied'
  }
  if (process.platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone') === 'denied' ? 'denied' : 'granted'
  return 'granted'
}

type CalendarOutcome = { ok: true; data: unknown } | { ok: false; code: string; message: string }

/**
 * 会议提醒要的那几场:前 5 分钟到后 15 分钟开始的日程(读日历走设备动作 `calendar.events.list`,授权同那一组)。
 * 只回提醒用得上的几样(标题、起止、全天);判该不该提醒在渲染层(@gugu/core/shared/voiceNotes meetingToRemind)。
 */
export async function upcomingMeetings(
  readCalendar: (args: Record<string, unknown>) => Promise<CalendarOutcome>,
  now = Date.now(),
): Promise<VoiceNoteMeetingsResult> {
  const outcome = await readCalendar({
    start: new Date(now - 5 * 60_000).toISOString(),
    end: new Date(now + 15 * 60_000).toISOString(),
    limit: 20,
  }).catch((error: unknown): CalendarOutcome => ({ ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error) }))
  if (!outcome.ok) return { ok: false, code: outcome.code }
  const rows = (outcome.data as { events?: unknown } | null)?.events
  const meetings = Array.isArray(rows)
    ? rows.flatMap((row) => {
        const e = row as Record<string, unknown>
        if (typeof e.event_id !== 'string' || typeof e.start !== 'string') return []
        return [{
          id: e.event_id,
          title: typeof e.title === 'string' ? e.title : '',
          start: e.start,
          end: typeof e.end === 'string' ? e.end : null,
          allDay: e.all_day === true,
        }]
      })
    : []
  return { ok: true, meetings }
}
