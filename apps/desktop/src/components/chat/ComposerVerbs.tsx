import { useTranslation } from 'react-i18next'
import { Clock, Sparkles } from '@/lib/icons'
import { setComposerVerb, type ComposerVerb } from '../../lib/composerVerbBridge'
import { UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
import { useInChatSlot } from '../../lib/shellSlots'
import { useChatStore } from '../../store/chatContext'
import { Button } from '../ui/Button'

/**
 * gugu-dev#181 输入框「+」右边两个词:「新任务」「定时任务」。选了一个,这个对话的输入框就换成那件事(composerVerbBridge),
 * 框里写了的话跟过去;这两个词连同整个框一起收起,换上会话页那一侧的新任务框(TaskDispatchComposer),点它标签上的 × 还原。
 *
 * 只有对话画在会话页的格子里(项目块、对话块)才有那一侧可换。老对话页(格子外)暂时退回整块的新建草稿
 * (ComposerEmbedRoot,群成员「新建 Agent」同一个入口,带着这个群当任务卡的落点);对话改成块之后删掉这一支。
 */
export function ComposerVerbs({ chatId, isGroupChat, draft, onCarried }: {
  chatId: string | null | undefined
  isGroupChat: boolean
  draft: string
  onCarried: () => void
}) {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  const inSlot = useInChatSlot()
  if (!chatId || !platform.capabilities.sessionHost) return null
  const pick = (verb: ComposerVerb) => {
    if (inSlot) {
      const chat = chats.find((candidate) => candidate.id === chatId)
      setComposerVerb(chatId, verb, draft, { name: chat?.name ?? '', joinable: chat?.kind === 'group' })
      if (draft.trim()) onCarried()
      return
    }
    window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
  }
  // 输入行窄(块并排、对话块)时两个词只留图标,❌ 把输入框挤没。格子里它们在框内底排;格子外在框左边,与坞同高。
  return (
    <span data-composer-verbs="" className={inSlot ? 'flex shrink-0 items-center gap-1' : 'flex h-[42px] shrink-0 items-center gap-1'}>
      {(inSlot || isGroupChat) && (
        <Button variant="ghost" size="sm" data-testid="composer-verb-task" aria-label={t('composer.verb.task')} title={t('composer.verb.task')} onClick={() => pick('task')}>
          <Sparkles size={14} /><span className="@max-[35rem]:hidden">{t('composer.verb.task')}</span>
        </Button>
      )}
      {inSlot && (
        <Button variant="ghost" size="sm" data-testid="composer-verb-schedule" aria-label={t('composer.verb.schedule')} title={t('composer.verb.schedule')} onClick={() => pick('schedule')}>
          <Clock size={14} /><span className="@max-[35rem]:hidden">{t('composer.verb.schedule')}</span>
        </Button>
      )}
    </span>
  )
}
