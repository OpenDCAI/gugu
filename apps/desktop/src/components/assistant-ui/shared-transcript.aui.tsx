import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ChatCommands, ChatContext, ChatState, TranscriptTurn } from '@gugu/session-chat-ui'
import { ChatTranscript, loadChatUi } from '@renderer/lib/chat/chat-transcript'

export type SharedChatRuntime = {
  context: ChatContext
  createChatState: typeof import('@gugu/session-chat-ui')['createChatState']
  commands: ChatCommands
}

/**
 * 桌面会话页那套转录(session-chat-ui)。手机页上只有真要画桌面那一行时才加载 ——
 * 首屏不背这一整个包。
 *
 * 加载一次、整页共用:每挂一次就重新 import 的话,行按位置复用(thread.aui ThreadMessages)时每张投递卡
 * 挂上来先空一帧、再长到真高,下面整列跟着跳(手机实测:送达一条,下面那块被推了 60px、44px 两下)。
 * 加载失败不缓存:下一次挂载重新加载(手机壳里宿主桥还没接上时第一次会抛)。
 */
let loadedRuntime: SharedChatRuntime | null = null
let loadingRuntime: Promise<SharedChatRuntime> | null = null
function loadSharedChatRuntime(): Promise<SharedChatRuntime> {
  loadingRuntime ??= Promise.all([
    // 与 ChatTranscript 同一次加载:运行时到手时它那边也已经能同步建视图了。
    loadChatUi(),
    import('@renderer/lib/chat/shared-chat-context'),
    import('@renderer/features/sessions/gugu-reason'),
    import('@renderer/localization/locale-store'),
  ]).then(([sessionChat, sharedContext, reasons, locale]) => {
    loadedRuntime = {
      context: sharedContext.getSharedChatContext(),
      createChatState: sessionChat.createChatState,
      // #7103 咕咕拒了这一轮的票:手机、投递卡上「回合失败」那一行也按原因表说那一句(与桌面同一张表);
      // 这里没有换模型、开会员的入口 ⇒ ❌ 摆按钮。
      commands: { describeRefusal: (guguReason) => ({ text: reasons.refusalText(guguReason, locale.translateSessionMessage) }) },
    }
    return loadedRuntime
  }).catch((error: unknown) => {
    loadingRuntime = null
    throw error
  })
  return loadingRuntime
}

/**
 * 任务页一挂上就开始加载(❌ 等第一行思考行挂上才加载):首次进 / 冷启动时时间线一到,思考行就能当场画出来,
 * ❌ 先 0 高、几十 ms 后撑开把下面整列推下去(WebView 113 实测 +28px)。失败不报:真要画时 hook 会再加载一次。
 */
export function preloadSharedChatRuntime(): void {
  void loadSharedChatRuntime().catch(() => undefined)
}

export function useSharedChatRuntime(): SharedChatRuntime | null {
  const [runtime, setRuntime] = useState<SharedChatRuntime | null>(loadedRuntime)
  useEffect(() => {
    if (runtime) return
    let active = true
    void loadSharedChatRuntime().then((loaded) => {
      if (active) setRuntime(loaded)
    })
    return () => {
      active = false
    }
  }, [runtime])
  return runtime
}

/**
 * 在 React 页面里画一段桌面会话页的转录,只画给定的这一轮。手机上的投递卡、thinking 行
 * 都走这里:和桌面是同一份组件、同一套判断,❌ 手机上另写一份。
 */
export function SharedTurnTranscript({
  runtime,
  uri,
  turn,
  commands: extraCommands,
}: {
  runtime: SharedChatRuntime
  uri: string
  turn: TranscriptTurn
  /** 这一段自己要接的口子(手机上的附件卡按所在会话开文件),叠在整页共用的那几个上面。 */
  commands?: ChatCommands
}): ReactElement {
  const { context, createChatState } = runtime
  const commands = useMemo(
    () => (extraCommands ? { ...runtime.commands, ...extraCommands } : runtime.commands),
    [runtime.commands, extraCommands],
  )
  // 建出来就把这一轮放进去:❌ 等 effect —— 那样头一帧画的是空转录,下一帧才长到真高。
  const state = useMemo<ChatState>(() => {
    const created = createChatState(context, { uri })
    created.transcript.history.seed([turn])
    return created
  }, [context, createChatState, uri])

  useEffect(() => {
    state.transcript.history.seed([turn])
  }, [state, turn])

  useEffect(() => () => state.dispose(), [state])

  return (
    <ChatTranscript
      context={context}
      state={state}
      commands={commands}
      composer="none"
      stickToBottom={false}
      pinUserMessages={false}
      embedded
      className="w-full"
    />
  )
}
