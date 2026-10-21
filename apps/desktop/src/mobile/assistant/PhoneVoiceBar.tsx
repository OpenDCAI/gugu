import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import '@/i18n/registerVoiceNotesCatalog'
import '@/session/renderer/features/assistant/voice-notes/voice-notes.css'
import './phone-voice-bar.css'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cloudComputerFailureKind, type CloudComputerFailureKind } from '@gugu/core/cloud/cloudComputer'
import { formatClock } from '@gugu/core/shared/voiceNotes'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { wakeCloudComputer } from '@/lib/cloudComputerStore'
import { ChevronRight, Pause, Play, RefreshCw, Square, X } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import type { PhoneRoute } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import type { VoiceJobView } from './phoneVoiceJobs'
import { openMicrophoneSettings, phoneVoiceJobs, phoneVoiceRecorder, useRecorder, useVoiceJobs, type PhoneVoice } from './phoneVoiceRuntime'
import { voiceFailureText } from './phoneVoiceNotesData'

const log = rendererLogger('mobile/assistant')

/** 「已传上去」那条挂多久(之后自己收起,笔记在记忆 → 语音笔记里,标「等转写」)。 */
const READY_LINGER_MS = 15_000
/** 连着这么久没声音就提示「未检测到声音」。 */
const NO_SOUND_HINT_MS = 8_000
/** 7 根波形条;每根的高度倍数(0.75 0.9 0.8 1 0.8 0.9 0.75,与桌面同一组)在 phone-voice-bar.css 里,跟 --vn-level 走。 */
const BARS = [0, 1, 2, 3, 4, 5, 6]
/** 不在聊天那一段时,条子离底边多远(底栏在这一格下面,自己不用垫安全区)。 */
const FREE_BOTTOM = 16

/** 录音条该跟着的那一条:最近开始的、没被关掉的;「好了」的只挂一会儿。 */
function barJob(jobs: readonly VoiceJobView[], now: number, readySince: Map<string, number>): VoiceJobView | null {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i]!
    if (job.dismissed) continue
    if (job.phase === 'uploaded' || job.phase === 'no_speech') {
      const since = readySince.get(job.id) ?? now
      readySince.set(job.id, since)
      if (now - since > READY_LINGER_MS) continue
    }
    return job
  }
  return null
}

/** 条子摆在输入框上面:量出输入框那一排离这一列底边多高。 */
function useAboveComposer(column: HTMLElement | null): number {
  const [bottom, setBottom] = useState(FREE_BOTTOM)
  useLayoutEffect(() => {
    if (!column) return setBottom(FREE_BOTTOM)
    const measure = () => {
      const row = column.querySelector('[data-chat-composer]') ?? column.querySelector('[data-chat-composer-row]')
      if (!row) return
      const gap = column.getBoundingClientRect().bottom - row.getBoundingClientRect().top
      if (gap > 0) setBottom(Math.round(gap + 10))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    const mutations = new MutationObserver(measure)
    mutations.observe(column, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [column])
  return bottom
}

/**
 * 录音条(同桌面,手机尺寸):录着 = 放弃 / 暂停 / 波形 / 计时 / 结束;暂停 = 放弃 / 继续 / 「已暂停」/ 计时 / 结束;
 * 录完 = 「正在传到 X 家里…」,点了去那一条;传完 = 「已传到 X 家里,等转写 · 查看」(转写在电脑上点「开始转写」);失败 = 重试 / 关闭。
 * 它住的云端宿主收回着:系统自己叫起来、说「正在连接，连上就上传」(owner 10-17 ❌「在休息 / 叫醒它」),没叫起来说原因 + 重试;
 * 连不上:「录音先存在手机上」。系统没给麦克风:说怎么开 + 去设置。
 * 摆在助理 App 的根上而不是聊天那一段里:切到别的格也看得到「还在录」,❌ 悄悄录。
 */
export function PhoneVoiceBar({
  voice,
  name,
  column,
  onChat,
  open,
}: {
  voice: PhoneVoice
  name: string
  /** 聊天那一列(量输入框的位置用);没在聊天那一段时条子贴在底边。 */
  column: HTMLElement | null
  onChat: boolean
  open: (route: PhoneRoute) => void
}) {
  const { t } = useTranslation('voiceNotes')
  const { t: ta } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const { toast } = useToast()
  const recorder = useRecorder()
  const jobs = useVoiceJobs()
  const readySince = useRef(new Map<string, number>())
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState(false)
  // 为哪条录音叫过它住的宿主(每条只叫一次;没叫起来留下原因,由人点重试)。
  const wokeFor = useRef(new Set<string>())
  // 叫醒没成的原因记在哪一条录音名下:换了一条 / 那条之后连上了(正在醒)就不再说它(❌ 拿旧原因说正在连接的那一条)。
  const [wakeIssue, setWakeIssue] = useState<{ jobId: string; kind: CloudComputerFailureKind } | null>(null)
  const anyJob = jobs.length > 0
  useEffect(() => {
    if (!anyJob) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [anyJob])
  // 麦克风半路没了(拔了耳机、换了设备、被来电占了):录音停在那儿,已录的照常整理 —— 说一句,❌ 悄悄变短。
  useEffect(() => {
    if (recorder.error !== 'interrupted') return
    toast(t('mic.interrupted'), 'info')
    phoneVoiceRecorder.clearError()
  }, [recorder.error, t, toast])

  const job = barJob(jobs, now, readySince.current)
  const barRef = useRef<HTMLDivElement>(null)
  const waveRef = useRef<HTMLSpanElement>(null)
  const recording = [...jobs].reverse().find((candidate) => candidate.phase === 'recording') ?? null
  const bottom = useAboveComposer(onChat ? column : null)
  const live = recorder.phase === 'recording' || recorder.phase === 'paused' || recorder.phase === 'stopping'
  const openNote = (id: string) => {
    phoneVoiceJobs.dismiss(id)
    open({ tab: 'memory', sub: `voice:${id}` })
  }
  const wake = (jobId: string) => {
    setWakeIssue(null)
    void wakeCloudComputer().catch((error: unknown) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'wake cloud computer failed')
      setWakeIssue({ jobId, kind: cloudComputerFailureKind(error) })
    })
  }
  // 有录音在等它家里、它住的云端宿主收回着:系统叫起来(录音本来就是要交给它的)。叫起来之后它又被收回、录音还没交上:
  // 还有活要交,再叫一次(这一条看到过它在醒就把记号放掉)。
  const pendingJob = job && job.phase !== 'recording' && job.phase !== 'failed' ? job : null
  const heldAsleep = pendingJob?.held === 'asleep' ? pendingJob.id : null
  const heldWaking = pendingJob?.held === 'waking' ? pendingJob.id : null
  useEffect(() => {
    if (!heldWaking) return
    wokeFor.current.delete(heldWaking)
    setWakeIssue((issue) => (issue?.jobId === heldWaking ? null : issue))
  }, [heldWaking])
  useEffect(() => {
    if (!heldAsleep || wokeFor.current.has(heldAsleep)) return
    wokeFor.current.add(heldAsleep)
    wake(heldAsleep)
  }, [heldAsleep])

  let content: ReactNode = null
  let notice = false
  if (recorder.phase === 'starting') {
    content = (
      <>
        <LoadingIndicator size="inline" />
        <span className="vn-bar-label">{t('bar.starting')}</span>
        <Button variant="ghost" className="vn-bar-text-btn" onClick={() => phoneVoiceRecorder.cancel()} data-testid="phone-voice-bar-cancel">
          {t('bar.cancel')}
        </Button>
      </>
    )
  } else if (live) {
    const paused = recorder.phase === 'paused'
    const stopping = recorder.phase === 'stopping'
    const silent = !paused && recorder.silentMs > NO_SOUND_HINT_MS
    content = (
      <>
        <Button variant="ghost" className="vn-bar-btn" aria-label={t('bar.discard')} title={t('bar.discard')} disabled={stopping} onClick={() => setConfirming(true)} data-testid="phone-voice-bar-discard">
          <X />
        </Button>
        <Button
          variant="ghost"
          className="vn-bar-btn"
          aria-label={paused ? t('bar.resume') : t('bar.pause')}
          title={paused ? t('bar.resume') : t('bar.pause')}
          disabled={stopping}
          onClick={() => (paused ? phoneVoiceRecorder.resume() : phoneVoiceRecorder.pause())}
          data-testid="phone-voice-bar-pause"
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        {paused ? (
          <span className="vn-bar-label">{t('bar.paused')}</span>
        ) : silent ? (
          <span className="vn-bar-hint" title={t('bar.noSoundDescription')} data-testid="phone-voice-bar-nosound">
            {t('bar.noSound')}
          </span>
        ) : (
          <span className="vn-wave" ref={waveRef} aria-label={t('bar.recording')}>
            {BARS.map((_, index) => (
              <span key={index} />
            ))}
          </span>
        )}
        <span className="vn-clock" data-testid="phone-voice-bar-clock">
          {formatClock(recorder.elapsedMs)}
        </span>
        <Button variant="ghost" className="vn-bar-btn" data-tone="stop" aria-label={t('bar.stop')} title={t('bar.stop')} disabled={stopping} onClick={() => phoneVoiceRecorder.stop()} data-testid="phone-voice-bar-stop">
          <Square />
        </Button>
      </>
    )
  } else if (voice.micDenied) {
    notice = true
    content = (
      <>
        <span className="vn-bar-label" data-tone="failed" data-testid="phone-voice-bar-denied">
          {t('mic.deniedPhone')}
        </span>
        <div className="vn-bar-actions">
          <Button variant="ghost" className="vn-bar-text-btn" onClick={() => void openMicrophoneSettings()} data-testid="phone-voice-bar-settings">
            {t('mic.openSettings')}
          </Button>
          <Button variant="ghost" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={voice.clearMicDenied}>
            <X />
          </Button>
        </div>
      </>
    )
  } else if (job && job.phase !== 'recording') {
    if (job.phase === 'failed') {
      notice = true
      content = (
        <>
          <span className="vn-bar-label" data-tone="failed" data-testid="phone-voice-bar-failed">
            {voiceFailureText(t, { stage: job.failure?.stage ?? 'transcribe', notice: job.failure?.notice ?? null, code: job.failure?.code ?? null, message: job.failure?.message ?? '' }, name)}
          </span>
          <div className="vn-bar-actions">
            <Button variant="ghost" className="vn-bar-text-btn" onClick={() => phoneVoiceJobs.retry(job.id)} data-testid="phone-voice-bar-retry">
              <RefreshCw />
              {t('retry')}
            </Button>
            <Button variant="ghost" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={() => phoneVoiceJobs.dismiss(job.id)}>
              <X />
            </Button>
          </div>
        </>
      )
    } else if (job.held) {
      // 录音还在手机上、它家里读写不了:说清在等什么;没叫起来说原因 + 重试。
      notice = true
      const failedKind = job.held === 'asleep' && wakeIssue?.jobId === job.id ? wakeIssue.kind : null
      const failed = failedKind !== null
      content = (
        <>
          <span className="vn-bar-label" data-testid="phone-voice-bar-held" data-held={failed ? 'connect-failed' : job.held}>
            {failed
              ? <>{ta('machine.connectFailed', { name })}{tc(`cloudComputer.reason.${failedKind}`)}{t('bar.heldKept')}</>
              : t(job.held === 'unreachable' ? 'bar.heldUnreachable' : 'bar.heldConnecting', { name })}
          </span>
          <div className="vn-bar-actions">
            {failed ? (
              <Button variant="ghost" className="vn-bar-text-btn" onClick={() => wake(job.id)} data-testid="phone-voice-bar-retry-connect">
                {ta('machine.retry')}
              </Button>
            ) : null}
            <Button variant="ghost" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={() => phoneVoiceJobs.dismiss(job.id)}>
              <X />
            </Button>
          </div>
        </>
      )
    } else {
      const done = job.phase === 'uploaded' || job.phase === 'no_speech'
      const label = job.phase === 'uploaded' ? t('bar.uploaded', { name }) : job.phase === 'no_speech' ? t('bar.noSpeech') : t('bar.sending', { name })
      content = (
        <>
          {done ? null : <LoadingIndicator size="inline" />}
          <Button variant="ghost" className="vn-bar-link" onClick={() => openNote(job.id)} data-testid="phone-voice-bar-open" data-phase={job.phase}>
            {label}
            {job.phase === 'uploaded' ? <span className="vn-bar-sub">{t('bar.open')}</span> : null}
            <ChevronRight />
          </Button>
          {done ? (
            <Button variant="ghost" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={() => phoneVoiceJobs.dismiss(job.id)}>
              <X />
            </Button>
          ) : null}
        </>
      )
    }
  }

  // 量出来的位置与此刻的音量落到元素上(几何值 ❌ 走 JSX 内联样式:inlineStyleBlocks 棘轮只许降);音量走 CSS 变量,波形条高度在样式表里算。
  useLayoutEffect(() => {
    barRef.current?.style.setProperty('bottom', `${bottom}px`)
    waveRef.current?.style.setProperty('--vn-level', recorder.level.toFixed(3))
  })

  // 条子挂着时给聊天那一列打个记号(CSS 据此给消息列表底下让位,最后一条不被盖住)。
  const shown = content !== null
  useEffect(() => {
    if (!column || !shown || !onChat) return
    column.setAttribute('data-voice-bar', '')
    return () => column.removeAttribute('data-voice-bar')
  }, [column, shown, onChat])

  return (
    <>
      {shown ? (
        <div className="vn-bar" ref={barRef} data-notice={notice || undefined} data-testid="phone-voice-bar" data-phase={recorder.phase !== 'idle' ? recorder.phase : (job?.phase ?? 'notice')}>
          {content}
        </div>
      ) : null}
      <PhoneConfirmDialog
          open={confirming}
          title={t('bar.discardTitle')}
          body={t('bar.discardBody')}
          confirmLabel={t('bar.discardConfirm')}
          failedText={t('bar.discardFailed')}
          testId="phone-voice-discard"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            if (recording) phoneVoiceJobs.discard(recording.id)
            else phoneVoiceRecorder.stop()
          }}
        />

    </>
  )
}
