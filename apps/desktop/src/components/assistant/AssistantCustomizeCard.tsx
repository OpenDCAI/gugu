import { useTranslation } from 'react-i18next'
import { ChevronRight, UserRound, X } from '@/lib/icons'
import { retireCustomizeCard } from '../../lib/assistantSetupState'
import { Button } from '../ui/Button'
import '../../i18n/registerAssistantCatalog'

/**
 * 开通后聊天里那张「自定义」卡(product spec 开通那段,照 dots「自定义你的 dot ›」):
 * 它开口问「想给我起个名字吗?」,这张卡就是去改名字和形象的入口。点进去或关掉 = 不再出现;没递过 = 不画。
 * 放在输入框工具行左侧，与「灵感」共用一行。
 */
/** 调用方用 useCustomizeCardOffered 判断是否展示；打开或关闭都会保存到原有账号状态。 */
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
        title={t('chat.customizeCard', { name })}
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
