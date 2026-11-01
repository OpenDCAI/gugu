import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useBackLayer } from '../ui/sheetStack'
import { rendererLogger } from '../../lib/log'
import { isServerMessage } from '@gugu/core/shared/ui/messageState'

const selectLog = rendererLogger('chat/multi-select')

/**
 * @@@multi-select (#988) - 多选模式 + 选中消息 id 集。进多选预选触发消息，退出时清空。
 * 批量转发把选中的消息交给转发对话框(setForwardMessages);批量删除逐条走 deleteMessage。
 */
export function useMessageSelectMode({ activeChatId, mobile, messages, deleteMessage, setForwardMessages }: {
  activeChatId: string | null
  mobile: boolean
  messages: readonly MessageItem[]
  deleteMessage: (messageId: string) => Promise<void>
  setForwardMessages: Dispatch<SetStateAction<MessageItem[]>>
}) {
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 退出多选模式（清空选中）。批量动作完成后或点「取消」时调用。
  const exitSelectMode = useCallback(() => { setSelectMode(false); setSelectedIds(new Set()) }, [])
  useBackLayer(exitSelectMode, mobile && selectMode) // 手机多选态:安卓返回键先退出多选,❌ 直接退回会话列表

  // 进入多选模式：从 More 菜单「多选」触发，预选触发的那条消息。
  const enterSelectMode = useCallback((msg: MessageItem) => {
    setSelectMode(true)
    setSelectedIds(new Set([msg.id]))
  }, [])

  const toggleSelect = useCallback((messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  // 批量转发：把选中的消息送进 ForwardMessageDialog（onForward 走 handleForwardTo 扇出）。
  const handleBatchForward = useCallback(() => {
    const selected = messages.filter((m) => selectedIds.has(m.id) && isServerMessage(m))
    if (selected.length === 0) return
    setForwardMessages(selected)
  }, [messages, selectedIds, setForwardMessages])

  // 批量删除：循环复用单条 deleteMessage（无批量 RPC），与单条删除同语义（不加额外确认）。
  const handleBatchDelete = useCallback(() => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    for (const id of ids) {
      deleteMessage(id).catch((err) => {
        selectLog.error({ messageId: id, error: String(err) }, 'batch deleteMessage failed')
      })
    }
    exitSelectMode()
  }, [selectedIds, deleteMessage, exitSelectMode])

  // 切换会话即退出多选 + 清空选中：否则上一个会话的选中集泄露到新会话，
  // 批量删除会对旧会话的消息 id 调用 deleteMessage（误删非当前会话的消息）、批量转发也会扇出错对象。
  useEffect(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [activeChatId])

  return { selectMode, selectedIds, exitSelectMode, enterSelectMode, toggleSelect, handleBatchForward, handleBatchDelete }
}
