import { useEffect } from 'react'
import { takeComposerCarry, useComposerVerb } from '../../lib/composerVerbBridge'

/**
 * 选了「新任务 / 定时任务」:会话页那一侧换上它的框,这个框整个收起(返回 true)。
 * 点了那个框标签上的 ×:写的话交回这里(setText)。
 */
export function useComposerVerbTakeover(chatId: string | null | undefined, setText: (text: string) => void): boolean {
  const verbTakesOver = useComposerVerb(chatId) !== null
  useEffect(() => {
    const back = verbTakesOver || !chatId ? '' : takeComposerCarry(chatId)
    if (back) setText(back)
  }, [verbTakesOver, chatId, setText])
  return verbTakesOver
}
