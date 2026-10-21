import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'

/**
 * @@@1170 ① 首次对话引导：agent DM 零消息空态。延用 gg-tempty 空态词汇（头像/首字母 tile +
 * 标题 + sub），加两条建议首句（点击预填 composer）把用户带进首次对话。onboarding
 * 建完首个 agent 即落到此处（落地已由 store 持有 activeChatId 保证，见 PR 说明）。
 * 只在这条线真读过、确实一条都没有时出现;读失败另说读不到(#7199)。从 ChatAreaPanel 抽出:版式未变,
 * 建议句由裸 button 换成 ui/Button(secondary·md 同为 32 高 / 14 内距 / 正文字号),圆角、边框、底色照旧。
 */
export function AgentFirstConversationEmpty({ name, onPick }: { name: string; onPick: (text: string) => void }) {
  const { t } = useTranslation('messaging')
  const suggestions = [
    t('chatArea.suggestions.help'),
    t('chatArea.suggestions.introduction'),
  ]
  return (
    <div
      data-testid="agent-first-conversation-empty"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}
    >
      <div style={{ fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
        {t('chatArea.firstConversationTitle', { name })}
      </div>
      <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', maxWidth: 260, lineHeight: 1.5 }}>
        {t('chatArea.firstConversationDescription')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 4 }}>
        {suggestions.map((s) => (
          <Button key={s} onClick={() => onPick(s)} className="rounded-[var(--radius-thread)] border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            {s}
          </Button>
        ))}
      </div>
    </div>
  )
}
