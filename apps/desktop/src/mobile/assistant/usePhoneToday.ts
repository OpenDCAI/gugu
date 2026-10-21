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
  const [view, setView] = useState<TodayFeedView>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    const read = () =>
      readChatFolderText(chatId, TODAY_FILE_NAME).then(
        (file) => !cancelled && setView({ state: 'read', read: todayReadOf(file) }),
        (error: unknown) => {
          if (cancelled) return
          const cause = error instanceof ChatFolderReadError ? new TodayReadError(error.kind, error.message) : error
          setView({ state: 'error', error: cause, retry: () => setAttempt((n) => n + 1) })
        },
      )
    void read()
    const timer = window.setInterval(() => void read(), TODAY_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [chatId, attempt])
  return view
}
