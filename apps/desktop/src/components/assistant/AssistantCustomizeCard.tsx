import { useTranslation } from 'react-i18next'
import { ChevronRight, UserRound, X } from '@/lib/icons'
import { retireCustomizeCard } from '../../lib/assistantSetupState'
import { Button } from '../ui/Button'
import '../../i18n/registerAssistantCatalog'

/**
 * 开通后聊天里那张「自定义」卡(product spec 开通那段,照 dots「自定义你的 dot ›」):
 * 它开口问「想给我起个名字吗?」,这张卡就是去改名字和形象的入口。点进去或关掉 = 不再出现;没递过 = 不画。
 * 接在消息流末尾(ChatAreaPanel 的 footer 那一格),与「它在处理」同一个位置。
 */
/** 调用方先用 useCustomizeCardOffered(lib/assistantSetupState)判断递没递过(没递过就别把它放进 footer —— footer 有东西会压掉运行条)。 */
export function AssistantCustomizeCard({ ownerUserId, name, onOpen }: { ownerUserId: string; name: string; onOpen: () => void }) {
  const { t } = useTranslation('assistant')
  return (
    <div className="ta-customize-card" data-testid="assistant-customize-card">
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        onClick={() => {
          retireCustomizeCard(ownerUserId)
          onOpen()
        }}
        data-testid="assistant-customize-card-open"
      >
        <UserRound size={16} aria-hidden />
        <span>{t('chat.customizeCard', { name })}</span>
        <ChevronRight size={14} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        aria-label={t('chat.customizeCardDismiss')}
        title={t('chat.customizeCardDismiss')}
        onClick={() => retireCustomizeCard(ownerUserId)}
        data-testid="assistant-customize-card-dismiss"
      >
        <X size={12} aria-hidden />
      </Button>
    </div>
  )
}
