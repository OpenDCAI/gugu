import { useEffect, useState } from 'react'
import { readChatFolderText } from '@/lib/chatFolder'
import { ChatFolderReadError } from '@/session/shared/extensions/chat-folder-text'
import type { TodayFeedView } from '@/session/renderer/features/assistant/assistant-today-feed'
import { TODAY_FILE_NAME, TODAY_REFRESH_MS, TodayReadError, todayReadOf } from '@/session/renderer/features/assistant/assistant-today-file'

/**
 * 手机上读私聊文件夹里的 today.json:窗口里 fetch(lib/chatFolder.ts;文件服务要答跨域预检,gugu-supabase #119)。
 * 「动态」那一格与「<名字>」那一格的日记都读它;摆着时每分钟再问一次,再问时照旧摆着上一份,❌ 闪回「正在读」。
 */
export function usePhoneToday(chatId: string): TodayFeedView {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ chatId: string; attempt: number; view: TodayFeedView } | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const file = await readChatFolderText({ chat: chatId, name: TODAY_FILE_NAME })
        const value = todayReadOf(file)
        if (!cancelled) setResult({ chatId, attempt, view: { state: 'read', read: value } })
      } catch (error) {
        if (cancelled) return
        const cause = error instanceof ChatFolderReadError ? new TodayReadError(error.kind, error.message) : error
        setResult({ chatId, attempt, view: { state: 'error', error: cause, retry: () => setAttempt((n) => n + 1) } })
      } finally {
        // Slow file requests must finish before another poll can replace their result.
        if (!cancelled) timer = setTimeout(() => void read(), TODAY_REFRESH_MS)
      }
    }
    void read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chatId, attempt])
  return result?.chatId === chatId && result.attempt === attempt ? result.view : { state: 'loading' }
}
