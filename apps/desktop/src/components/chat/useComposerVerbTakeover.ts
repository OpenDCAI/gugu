import { useEffect } from 'react'
import { takeComposerCarry, useComposerVerb } from '../../lib/composerVerbBridge'
import { useChatStore } from '../../store/chatContext'

/**
 * 选了「新任务 / 定时任务」:会话页那一侧换上它的框,这个框整个收起(返回 true)。
 * 点了那个框标签上的 ×:写的话交回编辑器。
 */
export function useComposerVerbTakeover(chatId: string | null | undefined): boolean {
  const { writeDraft } = useChatStore('writeDraft')
  const verbTakesOver = useComposerVerb(chatId) !== null
  useEffect(() => {
    const back = verbTakesOver || !chatId ? '' : takeComposerCarry(chatId)
    if (back) writeDraft(chatId, back)
  }, [verbTakesOver, chatId, writeDraft])
  return verbTakesOver
}
