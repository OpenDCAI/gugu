import { useTranslation } from 'react-i18next'
import { PluginIcon } from '../../session/renderer/lib/components/plugin-icon'
import { setComposerVerb, useDefaultTaskAgent, type ComposerVerb } from '../../lib/composerVerbBridge'
import { UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
import { useInChatSlot } from '../../lib/shellSlots'
import { useChatStore } from '../../store/chatContext'
import { Button } from '../ui/Button'
import { sessionComposerBox } from '../../session/renderer/features/sessions/session-composer-styles'

// 格子里底排的间距,同会话框底排(sessionComposerBox)。
const SLOT_VERBS_STYLE = { gap: sessionComposerBox.toolbarGapPx } as const

/**
 * gugu-dev#181 输入框「+」右边那个「新任务」。选了它,这个对话的输入框就换成新任务(composerVerbBridge),
 * 框里写了的话跟过去;它连同整个框一起收起,换上会话页那一侧的新任务框(TaskDispatchComposer),点它标签上的 × 还原。
 *
 * 只有对话画在会话页的格子里(项目块、对话块)才有那一侧可换。老对话页(格子外)暂时退回整块的新建草稿
 * (ComposerEmbedRoot,群成员「新建 Agent」同一个入口,带着这个群当任务卡的落点);对话改成块之后删掉这一支。
 */
export function ComposerVerbs({ chatId, isGroupChat, draft, onCarried }: {
  chatId: string | null | undefined
  isGroupChat: boolean
  draft: () => string
  onCarried: () => void
}) {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  const inSlot = useInChatSlot()
  const taskAgent = useDefaultTaskAgent()
  if (!chatId || !platform.capabilities.sessionHost) return null
  const pick = (verb: ComposerVerb) => {
    if (inSlot) {
      const chat = chats.find((candidate) => candidate.id === chatId)
      const carry = draft()
      setComposerVerb(chatId, verb, carry, { name: chat?.name ?? '', joinable: chat?.kind === 'group' })
      if (carry.trim()) onCarried()
      return
    }
    window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
  }
  // 格子里它们在框内底排;格子外在框左边,与坞同高。
  return (
    <span data-composer-verbs="" className={inSlot ? 'flex shrink-0 items-center' : 'flex h-[42px] shrink-0 items-center gap-1'} style={inSlot ? SLOT_VERBS_STYLE : undefined}>
      {(inSlot || isGroupChat) && (
        <Button variant="ghost" size="sm" data-testid="composer-verb-task" aria-label={t('composer.verb.task')} title={t('composer.verb.task')} onClick={() => pick('task')}>
          {taskAgent ? <PluginIcon id={taskAgent.id} icon={taskAgent.icon} size={14} /> : null}<span>{t('composer.verb.task')}</span>
        </Button>
      )}
    </span>
  )
}
