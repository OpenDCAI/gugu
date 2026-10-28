import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { Pause, Play } from '@/lib/icons'
import { writeFirstRunTerminalSeen } from '../../lib/firstRun'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled'
import { Toggle } from '../settings/SettingsPrimitives'
import { Button } from '../ui/Button'
import { Hint } from '../ui/Tooltip'
import film from '../../assets/first-run/session-terminal.webm'
import poster from '../../assets/first-run/session-terminal.webp'
import './first-run-terminal.css'

/**
 * 首次引导里单独一页的「会话终端」(owner 10-27:单独一页,优雅、简洁)。
 * 只有四样:标题、一句说明、真实录屏(静音循环)、开关 + 继续。❌ 利弊清单、❌ 卡片套卡片、❌ 小字说明。
 * 开关就是「设置 → 通用 → 终端」那一个(本机 `terminal.enabled`),默认值由启动迁移定(新装 = 关),这里只读和改。
 * 录屏:mac1 上真 Electron + 预发测试号,Codex 在终端里写 greet.py 并运行。只裁终端那一块并放大(卡片宽度下要读得清指令、写文件、运行结果),等待的那几秒 3 倍速。
 */
export function FirstRunTerminal({ userId, onBack, onDone }: { userId: string; onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation('main')
  const enabled = useTerminalEnabled()
  const { update } = useAppSettingsKey('terminal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「继续」始终能点(规范 3):不动开关 = 保留默认的关。只记「看过这一页」,中途退出再进不再停在这里。
  const proceed = async () => {
    setBusy(true)
    setError(null)
    try {
      await writeFirstRunTerminalSeen(userId)
      onDone()
    } catch (cause) {
      rendererLogger('first-run').error({ error: String(cause) }, 'save terminal step failed')
      setError(messageForUser(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1 className="ta-onb-title">{t('firstRun.terminalTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.terminalSub')}</p>
      <TerminalFilm />
      <div className="first-run-terminal-choice">
        <label className="first-run-terminal-switch">
          <span>{t('firstRun.terminalToggle')}</span>
          <Toggle checked={enabled} onChange={(next) => update({ enabled: next })} ariaLabel={t('firstRun.terminalToggle')} />
        </label>
        <span className="first-run-terminal-later">{t('firstRun.terminalLater')}</span>
      </div>
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions first-run-step-actions">
        <Button variant="ghost" size="lg" className="rounded-full" onClick={onBack} disabled={busy} data-testid="first-run-terminal-back">{t('firstRun.back')}</Button>
        <Button variant="primary" size="lg" className="rounded-full" onClick={() => void proceed()} disabled={busy} data-testid="first-run-terminal-continue">
          {t('firstRun.continue')}
        </Button>
      </div>
    </>
  )
}

/** 静音循环自动播;能暂停。系统开了「减少动态效果」只给封面帧(规范 3)。 */
function TerminalFilm() {
  const { t } = useTranslation('main')
  const video = useRef<HTMLVideoElement>(null)
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [playing, setPlaying] = useState(!still)
  const playbackLabel = playing ? t('firstRun.terminalPause') : t('firstRun.terminalPlay')
  if (still) return <img className="first-run-terminal-film" src={poster} alt={t('firstRun.terminalTitle')} data-testid="first-run-terminal-film" />
  const toggle = () => {
    const el = video.current
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }
  return (
    <div className="first-run-terminal-film-frame">
      <video ref={video} className="first-run-terminal-film" src={film} poster={poster} autoPlay muted loop playsInline
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        aria-label={t('firstRun.terminalTitle')} data-testid="first-run-terminal-film" />
      <Hint label={playbackLabel} side="top">
        <Button variant="secondary" size="icon" className="first-run-terminal-film-toggle rounded-full" onClick={toggle}
          aria-label={playbackLabel} data-testid="first-run-terminal-film-toggle">
          {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
        </Button>
      </Hint>
    </div>
  )
}
