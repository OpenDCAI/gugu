import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { ListChecks, MessageCircle } from '@/lib/icons'
import '../../i18n/registerAssistantCatalog'
import '../../i18n/registerMobileWorkspaceCatalog'

/**
 * 「认识咕咕」介绍个人助理、工作区和协作对话三种用途，不把能力介绍当作手机底栏目录。
 * 新账号的首次引导里画它;开通咕咕时它兼任介绍(❌ 再来一屏欢迎)。外层由调用方给 `.ta-onb` 卡与主题色。
 */
export function AssistantIntro({
  primaryLabel,
  onPrimary,
  laterLabel,
  onLater,
  busy = false,
  error = null,
}: {
  primaryLabel: string
  onPrimary: () => void
  /** 没有 = 不出文字链(开通咕咕时:人已经点进咕咕那一格,不再问「先逛逛」)。 */
  laterLabel?: string
  onLater?: () => void
  busy?: boolean
  error?: string | null
}) {
  const { t } = useTranslation('assistant')
  const { t: tWorkspace } = useTranslation('mobileWorkspace')
  const rows: { key: string; icon: ReactNode; title: string; body: string }[] = [
    {
      key: 'gugu',
      icon: <Avatar name={t('rail')} seed="gugu-default" size={22} isAgent harnessBadge={false} />,
      title: t('intro.guguTitle'),
      body: t('intro.guguBody'),
    },
    { key: 'workspace', icon: <ListChecks size={20} />, title: tWorkspace('title'), body: t('intro.projectsBody') },
    { key: 'chats', icon: <MessageCircle size={20} />, title: t('intro.chatsTitle'), body: t('intro.chatsBody') },
  ]
  return (
    <>
      <Avatar name={t('rail')} seed="gugu-default" size={88} isAgent harnessBadge={false} />
      <h1 className="ta-onb-title">{t('intro.title')}</h1>
      <p className="ta-onb-sub">{t('intro.sub')}</p>
      <ul className="ta-onb-intro" data-testid="assistant-intro-rows">
        {rows.map((row) => (
          <li key={row.key} className="ta-onb-intro-row" data-intro-row={row.key}>
            <span className="ta-onb-intro-icon" aria-hidden>
              {row.icon}
            </span>
            <span className="ta-onb-intro-text">
              <span className="ta-onb-choice-title">{row.title}</span>
              <span className="ta-onb-choice-body">{row.body}</span>
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
