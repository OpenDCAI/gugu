import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Sparkles } from '@/lib/icons'
import { setComposerVerb, type ComposerVerb } from '../../lib/composerVerbBridge'
import { UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
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
  const [inSlot, setInSlot] = useState<boolean | null>(null)
  const measure = useCallback((element: HTMLSpanElement | null) => {
    if (element) setInSlot(Boolean(element.closest('[data-chat-slot]')))
  }, [])
  if (!chatId || !platform.capabilities.sessionHost) return null
  const pick = (verb: ComposerVerb) => {
    if (inSlot) {
      setComposerVerb(chatId, verb, draft)
      if (draft.trim()) onCarried()
      return
    }
    window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
  }
  return (
    <span ref={measure} data-composer-verbs="" className="flex h-[42px] shrink-0 items-center gap-1">
      {(inSlot || isGroupChat) && (
        <Button variant="ghost" size="sm" data-testid="composer-verb-task" onClick={() => pick('task')}>
          <Sparkles size={14} />{t('composer.verb.task')}
        </Button>
      )}
      {inSlot && (
        <Button variant="ghost" size="sm" data-testid="composer-verb-schedule" onClick={() => pick('schedule')}>
          <Clock size={14} />{t('composer.verb.schedule')}
        </Button>
      )}
    </span>
  )
}
