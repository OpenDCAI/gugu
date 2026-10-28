import { useTranslation } from 'react-i18next'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled'
import { Toggle } from '../settings/SettingsPrimitives'
import { Button } from '../ui/Button'
import film from '../../assets/first-run/session-terminal.webm'
import poster from '../../assets/first-run/session-terminal.webp'
import './first-run-terminal.css'

/**
 * 首次引导里单独一页的「会话终端」(owner 10-27:单独一页,优雅、简洁)。
 * 只有四样:标题、一句说明、真实录屏(静音循环)、开关 + 继续。❌ 利弊清单、❌ 卡片套卡片、❌ 小字说明。
 * 开关就是「设置 → 通用 → 终端」那一个(本机 `terminal.enabled`),默认值由启动迁移定(新装 = 关),这里只读和改。
 * 录屏:mac1 上真 Electron + 预发测试号,Codex 在终端里写 greet.py 并运行(中文界面,裁掉了透明的功能栏)。
 */
export function FirstRunTerminal({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('main')
  const enabled = useTerminalEnabled()
  const { update } = useAppSettingsKey('terminal')
  return (
    <>
      <h1 className="ta-onb-title">{t('firstRun.terminalTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.terminalSub')}</p>
      <video className="first-run-terminal-film" src={film} poster={poster} autoPlay muted loop playsInline
        aria-label={t('firstRun.terminalTitle')} data-testid="first-run-terminal-film" />
      <div className="first-run-terminal-actions">
        <label className="first-run-terminal-switch">
          <span>{t('firstRun.terminalToggle')}</span>
          <Toggle checked={enabled} onChange={(next) => update({ enabled: next })} ariaLabel={t('firstRun.terminalToggle')} />
        </label>
        <Button variant="primary" size="lg" className="rounded-full" onClick={onDone} data-testid="first-run-terminal-continue">
          {t('firstRun.continue')}
        </Button>
      </div>
    </>
  )
}
