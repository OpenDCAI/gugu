import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { QUICK_CHAT_CHANNELS, QUICK_CHAT_WINDOW_NAME } from '../../lib/quickChatIpc'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { desktopIpc } from '../../platform/desktopIpc'
import { mirrorDocument } from '../../session/renderer/lib/aux-document'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { QuickChat, type QuickChatAssistant } from './QuickChat'
import { quickChatShortcutLabel, useQuickChatState } from './useQuickChatState'

const log = rendererLogger('assistant/quick-chat')

type Mounted = { win: Window; root: HTMLElement }

/**
 * #7199「快速聊天」在主窗这一侧的那一半:登录着就预先开好那扇小窗(同源子窗,主进程照 quick-chat-window.ts 配外观、藏着),
 * 按快捷键时主进程直接把它摆出来 —— 不等加载。界面由这里画进去(同一份登录、数据、实时)。
 * 小窗被真关了(主窗重载会关掉所有子窗)/ 还没开时按快捷键:主进程说一声 open,这里重开一扇。
 * 只在桌面版:网页与手机没有全局快捷键,也没有子窗。
 */
export function QuickChatHost({
  assistant,
  assistantState,
  chatId,
  chatFailed,
  retryChat,
}: {
  assistant: QuickChatAssistant | null
  assistantState: 'found' | 'loading' | 'none' | 'unreadable'
  chatId: string | null
  chatFailed: { error: string } | null
  retryChat: () => void
}) {
  const { t } = useTranslation('assistant')
  // desktopIpc() 每次给一个新对象:定在挂上那一刻(❌ 每画一次就当成换了一条线、把小窗重开一遍)。
  const [ipc] = useState(desktopIpc)
  const [mounted, setMounted] = useState<Mounted | null>(null)
  const [generation, setGeneration] = useState(0)
  const [visible, setVisible] = useState(false)
  const { state } = useQuickChatState()
  const mountedRef = useRef<Mounted | null>(null)
  mountedRef.current = mounted

  useLayoutEffect(() => {
    if (!ipc) return
    const win = window.open('about:blank', QUICK_CHAT_WINDOW_NAME, 'width=520,height=680')
    if (!win) {
      log.warn({}, '快速聊天的小窗没开出来')
      return
    }
    const doc = win.document
    // 同一个名字再开一次拿到的是同一扇(登出再登入):先清掉上一次留下的。
    doc.head.replaceChildren()
    doc.body.replaceChildren()
    const stopMirror = mirrorDocument(document, doc)
    Object.assign(doc.body.style, { margin: '0', height: '100vh', overflow: 'hidden' })
    const root = doc.createElement('div')
    doc.body.append(root)
    const onGone = () => setMounted((current) => (current?.win === win ? null : current))
    win.addEventListener('pagehide', onGone)
    setMounted({ win, root })
    return () => {
      win.removeEventListener('pagehide', onGone)
      stopMirror()
      setMounted(null)
      if (!win.closed) {
        doc.head.replaceChildren()
        doc.body.replaceChildren()
        // 主进程把「关」当「收起」:这扇留着(藏着),下次登录再用同一扇。
        win.close()
      }
    }
  }, [ipc, generation])

  useEffect(() => {
    if (!ipc) return
    const offOpen = ipc.eventOn(QUICK_CHAT_CHANNELS.open, () => {
      const current = mountedRef.current
      if (!current || current.win.closed) setGeneration((n) => n + 1)
    })
    const offVisibility = ipc.eventOn(QUICK_CHAT_CHANNELS.visibility, (shown) => setVisible(shown === true))
    return () => {
      offOpen()
      offVisibility()
    }
  }, [ipc])

  const name = assistant?.display_name ?? t('quickChat.assistant')
  useEffect(() => {
    if (mounted) mounted.win.document.title = t('quickChat.title', { name })
  }, [mounted, name, t])

  if (!ipc || !mounted) return null
  const shortcut = state ? quickChatShortcutLabel(state) : ''
  return createPortal(
    <QuickChat
      assistant={assistant}
      assistantState={assistantState}
      chatId={chatId}
      chatFailed={chatFailed}
      retryChat={retryChat}
      visible={visible}
      shortcut={shortcut}
      onClose={() => void ipc.invoke(QUICK_CHAT_CHANNELS.hide)}
      onOpenMain={() => {
        // 去主窗里的「助理」:有它 = 和它的聊天;还没有 = 开通那一页(同一个视图)。
        window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
        appState.navigation.navigate('assistant')
        void ipc.invoke(QUICK_CHAT_CHANNELS.openMain)
      }}
    />,
    mounted.root
  )
}
