import { useTranslation } from 'react-i18next'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { DEFAULT_ASSISTANT_LOOK, type AgentLook } from '../agentAvatar/look'
import { Button } from '../ui/Button'
import { useMobileShell } from '@/hooks/useMobileShell'
import '../../i18n/registerAssistantCatalog'

/**
 * 一屏介绍:个人助理单独在上,下面两项对应当前设备的真实入口。
 * 新账号的首次引导里画它;开通咕咕时它兼任介绍(❌ 再来一屏欢迎)。外层由调用方给 `.ta-onb` 卡与主题色。
 */
export function AssistantIntro({
  primaryLabel,
  onPrimary,
  laterLabel,
  onLater,
  busy = false,
  error = null,
  look = DEFAULT_ASSISTANT_LOOK,
}: {
  primaryLabel: string
  onPrimary: () => void
  /** 没有 = 不出文字链(开通咕咕时:人已经点进咕咕那一格,不再问「先逛逛」)。 */
  laterLabel?: string
  onLater?: () => void
  busy?: boolean
  error?: string | null
  /** 开通流程退回介绍页时沿用已经确认的形象。 */
  look?: AgentLook
}) {
  const { t } = useTranslation('assistant')
  const mobile = useMobileShell()
  const device = mobile ? 'phone' : 'desktop'
  const rows = mobile ? ['messages', 'partners'] as const : ['projects', 'chats'] as const
  return (
    <>
      <AgentAvatar id="assistant-draft" name={t('rail')} look={look} size={88} />
      <h1 className="ta-onb-title">{t('intro.title')}</h1>
      <div className="ta-onb-intro-gugu" data-intro-row="gugu" data-intro-device={device}>
        <strong className="ta-onb-choice-title">{t('intro.guguTitle')}</strong>
        <p className="ta-onb-choice-body">{t(`intro.${device}.guguBody`)}</p>
      </div>
      <ul className="ta-onb-intro" data-testid="assistant-intro-rows" data-intro-device={device}>
        {rows.map((row) => (
          <li key={row} className="ta-onb-intro-row" data-intro-row={row}>
            <span className="ta-onb-intro-text">
              <strong className="ta-onb-choice-title">{t(`intro.${row}Title`)}</strong>
              <span className="ta-onb-choice-body">{t(`intro.${device}.${row}Body`)}</span>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions ta-onb-actions-stack">
        <Button
          variant="primary"
          size="lg"
          className="rounded-full ta-onb-primary"
          onClick={onPrimary}
          disabled={busy}
          aria-busy={busy}
          data-testid="assistant-intro-primary"
        >
          {primaryLabel}
        </Button>
        {laterLabel && onLater ? (
          <Button variant="ghost" size="sm" className="self-center rounded-full" onClick={onLater} disabled={busy} data-testid="assistant-intro-later">
            {laterLabel}
          </Button>
        ) : null}
      </div>
    </>
  )
}
