import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { meetingKey, meetingRemindable, meetingToRemind, type UpcomingMeeting } from '@gugu/core/shared/voiceNotes'
import { platform } from '../../platform'
import { readAssistantShellBridge, type AssistantVoiceNoteHandler } from '../../lib/assistantShellBridge'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Mic, X } from '../../lib/icons'
import { UI_EVENTS } from '../../lib/uiEvents'
import { invokeOnMachine } from '../../session/renderer/lib/ipc'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { VOICE_NOTE_MEETINGS_CHANNEL, type VoiceNoteMeetingsResult } from '../../session/shared/core/voice-notes'
import { meetingReminderEnabled } from '../../lib/meetingReminderPref'
import '../../i18n/registerVoiceNotesCatalog'
import { useVoiceNoteHandler } from './useVoiceNoteHandler'

/** 多久看一次日历(提醒在开会前 1 分钟弹,半分钟一看才赶得上)。 */
const POLL_MS = 30_000
/** 提醒过的那几场记在这台电脑上(记最近 256 条),关了 App 再开也不重复弹。 */
const SEEN_KEY = 'gugu.voiceNotes.remindedMeetings'
const SEEN_MAX = 256

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {
    // 记不住就算了:最坏是同一场会再提醒一次。
  }
}

/** 等助理 App 挂上、把录音机登记到桥上(人从别的页点了「开始录音」,App 刚开始挂)。 */
function waitForHandler(timeoutMs: number): Promise<AssistantVoiceNoteHandler | null> {
  const bridge = readAssistantShellBridge()
  const now = bridge?.getVoiceNoteHandler() ?? null
  if (now || !bridge) return Promise.resolve(now)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(bridge.getVoiceNoteHandler())
    }, timeoutMs)
    const unsubscribe = bridge.subscribeVoiceNoteHandler(() => {
      const handler = bridge.getVoiceNoteHandler()
      if (!handler) return
      clearTimeout(timer)
      unsubscribe()
      resolve(handler)
    })
  })
}

function clock(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * #7199 会议提醒:这台电脑日历里有会快开始时(前 1 分钟,开始后 5 分钟内),
 * 右上角一张小卡「会议即将开始 · 开始录音」;窗口不在前台时再发一条系统通知。点「开始录音」= 打开助理 App 开录,
 * 录下的这条带着这场会的名字交给助理。日历读的是「设备 → 这台电脑能做的事」里连上的那一份,没连上就不提醒。
 * 只在有个人助理时看(录下的要交给它整理)。
 */
export function MeetingReminder({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('voiceNotes')
  const [meeting, setMeeting] = useState<UpcomingMeeting | null>(null)
  const [failed, setFailed] = useState(false)
  const [starting, setStarting] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const { recording } = useVoiceNoteHandler()

  const check = useCallback(async () => {
    if (!enabled || !meetingReminderEnabled()) return
    const result = (await invokeOnMachine(null, VOICE_NOTE_MEETINGS_CHANNEL).catch(() => null)) as VoiceNoteMeetingsResult | null
    if (!result?.ok) return
    seen.current ??= readSeen()
    const next = meetingToRemind(result.meetings, Date.now(), seen.current)
    if (!next) return
    seen.current.add(meetingKey(next))
    writeSeen(seen.current)
    setFailed(false)
    setMeeting(next)
    if (!document.hasFocus())
      void platform?.showNotification({ title: t('meeting.heading'), body: [next.title, `${clock(next.start)} - ${clock(next.end)}`].filter(Boolean).join(' · ') }).catch(() => undefined)
  }, [enabled, t])

  useEffect(() => {
    if (!enabled) return
    void check()
    const timer = window.setInterval(() => {
      void check()
      // 过了提醒的时间窗就自己收起(最晚开始后 5 分钟)。
      setMeeting((current) => (current && !meetingRemindable(current, Date.now()) ? null : current))
    }, POLL_MS)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, check])

  // 没有个人助理了(退出登录、云电脑没了):挂着的这张也收起。
  if (!meeting || !enabled) return null

  const start = async () => {
    setStarting(true)
    setFailed(false)
    window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
    appState.navigation.navigate('assistant')
    const ready = await waitForHandler(15_000)
    const ok = ready ? await ready.start({ title: meeting.title, start: meeting.start, end: meeting.end }) : false
    setStarting(false)
    if (ok) setMeeting(null)
    else setFailed(true)
  }

  // 一张小卡:右上角浮着,左边一道强调色,标题 + 「HH:mm - HH:mm」,右边「开始录音」,角上关掉。
  return (
    <div
      role="alertdialog"
      aria-label={t('meeting.heading')}
      data-testid="meeting-reminder"
      className="fixed right-4 top-12 z-[var(--z-banner)] flex w-[380px] max-w-[calc(100vw-32px)] items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--menu-bg)] py-3 pl-3 pr-2 text-[var(--menu-fg)] shadow-[var(--shadow-lift)]"
    >
      <span aria-hidden className="h-10 w-1 shrink-0 rounded-full bg-[var(--danger)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <strong className="truncate text-[length:var(--font-body)] font-semibold">{meeting.title || t('meeting.heading')}</strong>
        <span className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">
          {[t('meeting.heading'), [clock(meeting.start), clock(meeting.end)].filter(Boolean).join(' - ')].join(' · ')}
        </span>
        {failed ? <span className="text-[length:var(--font-caption)] text-[var(--danger)]">{t('meeting.error')}</span> : null}
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={starting || recording}
        title={recording ? t('meeting.recording') : undefined}
        onClick={() => void start()}
        data-testid="meeting-reminder-start"
      >
        <span className="inline-flex items-center gap-1 [&>svg]:h-4 [&>svg]:w-4">
          <Mic />
          {recording ? t('meeting.recording') : t('meeting.startRecording')}
        </span>
      </Button>
      <IconButton size="sm" aria-label={t('meeting.dismiss')} title={t('meeting.dismiss')} onClick={() => setMeeting(null)}>
        <X />
      </IconButton>
    </div>
  )
}
