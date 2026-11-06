import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { LoginPage } from './pages/LoginPage'
import { authCallbacks, startAuthCallbackRouting } from './lib/authCallbacks'
import { googleLogin } from './lib/googleLogin'
import { LoginMethodChangeNotice } from './components/LoginMethodChangeNotice'
import { logoutAndRelaunch } from './lib/authLogout'
import { MainLayout } from './layouts/MainLayout'
import { AgentJoinRoute } from './pages/AgentJoinRoute'
import { AuthContext, type AuthUser } from './store/auth'
import { ChatProvider } from './store/chat'
import { setPresenceBusContext } from './lib/agentPresenceStore'
import { ToastProvider } from './components/Toast'
import { Tooltip } from './components/ui/Tooltip'
import { UnfinishedAgentCreateSweeper } from './components/UnfinishedAgentCreateSweeper'
import { StarterContinuationHost } from './components/StarterContinuationHost'
import { ShareIntakeHost } from './mobile/share-intake/ShareIntakeHost'
import { AgentPresencePrewarm } from './components/AgentPresencePrewarm'
import { AgentStatusFeedBridge } from './components/AgentStatusFeedBridge'
import { ImagePreviewProvider } from './components/ImagePreviewProvider'
import { SessionExpiredNotice } from './components/SessionExpiredNotice'
import { FullScreenLoader } from './components/FullScreenLoader'
import { FirstRunGate } from './components/firstRun/FirstRunGate'
import { ShellErrorBoundary } from './components/ShellErrorBoundary'
import { ReleaseNotesOpener } from './components/ReleaseNotesOpener'
import { AppModalHost } from './components/appModal/AppModalHost'
import { ContentContextMenuHost } from './components/ContentContextMenuHost'
import { ThemeProvider } from './store/theme'
import { rendererCommandEventName } from './lib/rendererCommandProtocol'
import { sessionCoordinator } from './lib/sessionCoordinator'
import { publishSelfIdentity } from './lib/selfIdentityBridge'
import { installAssistantPanelHost } from './components/assistant/assistant-panel-host'
import { usePhoneImeDismiss } from './mobile/usePhoneImeDismiss'

import { platform } from './platform'
import { type RendererRpcHandlers, useRendererRpcHandlers } from './rpc-renderer/rendererRpc'

if (typeof window !== 'undefined') installAssistantPanelHost()

// ── URL-based view detection ───────────────────────────────────────────────────

/** 解析 /join/agent/:id 路径，返回 agentId 或 null */
function parseAgentJoinRoute(): string | null {
  const m = window.location.pathname.match(/^\/join\/agent\/([^/?#]+)/)
  return m ? m[1] : null
}

function AuthenticatedProduct({ user }: { user: AuthUser }) {
  const [effectsActive, setEffectsActive] = useState(false)
  const onShellCommitted = useCallback(() => setEffectsActive(true), [])

  useEffect(() => {
    // @@@3839 只交代**身份**。presence 缓存是按账号划界的,换人(含登出)时 store 自己清空;
    // 「有哪些 agent 值得预热」由真正知道这件事的会话列表去说(prewarmAgentPresence),
    // ❌ 不再从这里传一个恒为空、且 store 一个字都不读的 ownedAgentIds。
    setPresenceBusContext({ currentUserId: effectsActive ? user.id : null })
    return () => {
      setPresenceBusContext({ currentUserId: null })
    }
  }, [effectsActive, user.id])

  return (
    <ChatProvider active={effectsActive}>
      <ImagePreviewProvider>
        {/* 兜底(#5610 §2.5):主界面 render 抛错降成「这个界面出错了」,ChatProvider 与下面的宿主照常活着。洞不在这里修。 */}
        <ShellErrorBoundary>
          <MainLayout
            user={user}
            effectsActive={effectsActive}
            onShellCommitted={onShellCommitted}
          />
        </ShellErrorBoundary>
        <AgentPresencePrewarm />
        <AgentStatusFeedBridge />
        {/* 从前挂在已下架的 AgentCreateRetryHost 里,#6299 起直接挂在这里。 */}
        <StarterContinuationHost active={effectsActive} />
        <ShareIntakeHost active={effectsActive} />
        <UnfinishedAgentCreateSweeper active={effectsActive} />
        <SessionExpiredNotice />
        <ReleaseNotesOpener />
        <AppModalHost />
      </ImagePreviewProvider>
    </ChatProvider>
  )
}

export default function App() {
  usePhoneImeDismiss()

  const session = useSyncExternalStore(
    sessionCoordinator.subscribe,
    sessionCoordinator.getSnapshot,
    sessionCoordinator.getSnapshot,
  )
  const user = session.user
  const loading = session.status === 'boot-restoring'
  const authContextValue = {
    user,
    loading,
    status: session.status,
    updateUser: sessionCoordinator.updateUser,
    logout: logoutAndRelaunch,
  }
  useEffect(() => {
    document.title = platform.documentTitle
  }, [])

  // #5048 会话页投递卡对「自己发的」消息用本地 profile 显示发信人(spec delivery-envelope)。
  useEffect(() => {
    publishSelfIdentity(user
      ? { userId: user.id, displayName: user.nickname?.trim() || null, guguNumber: user.gugu_number ?? null }
      : null)
  }, [user])

  useEffect(() => {
    return sessionCoordinator.start()
  }, [])
  useEffect(startAuthCallbackRouting, [])
  useEffect(() => { authCallbacks.setAuthenticated(Boolean(session.session)) }, [session.session])
  useEffect(() => { googleLogin.initialize() }, [])

  const authRpcHandlers: RendererRpcHandlers = {
    // #5025 主进程问「现在登录的是谁」时,boot-restoring 期间的 null 不是答案而是「还没恢复完」。
    getSessionOwner: async (params) => {
      const waitMs = (params as { waitMs?: unknown } | null)?.waitMs
      return sessionCoordinator.waitForDecidedOwner(typeof waitMs === 'number' ? waitMs : 0)
    },
  }
  useRendererRpcHandlers(rendererCommandEventName('auth'), 'auth', authRpcHandlers, (reqId, result) => {
    platform.sendRendererCommandResult('auth', reqId, result)
  }, platform.capabilities.rendererCommandBridge, () => platform.sendRendererCommandReady('auth'))

  const agentJoinId = parseAgentJoinRoute()
  if (agentJoinId !== null) {
    return (
      <ThemeProvider>
        <ToastProvider>
          <ContentContextMenuHost />
          <AuthContext.Provider value={authContextValue}>
            <AgentJoinRoute agentId={agentJoinId} user={user} authLoading={loading} />
          </AuthContext.Provider>
        </ToastProvider>
      </ThemeProvider>
    )
  }

  if (loading) {
    return <FullScreenLoader />
  }

  // @@@4323 Tooltip.Provider 挂在这里而不是逐个触发器上:开合延迟是一份,分组行为
  // (一组之内已经弹过就立刻弹下一个)也只在 Provider 存在时才成立。
  if (!user) {
    return (
      <ThemeProvider>
        <Tooltip.Provider>
          <ToastProvider>
            <ContentContextMenuHost />
            <AuthContext.Provider value={authContextValue}>
              <LoginPage />
            </AuthContext.Provider>
          </ToastProvider>
        </Tooltip.Provider>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <Tooltip.Provider>
        <ToastProvider>
          <ContentContextMenuHost />
          <AuthContext.Provider value={authContextValue}>
            {/* 新账号先走一遍首次引导(product spec,#7348);老账号 / 走完的直接进主界面 */}
            <LoginMethodChangeNotice key={`login-notice:${user.id}`} userId={user.id} />
            <FirstRunGate key={user.id} user={user}>
              <AuthenticatedProduct key={user.id} user={user} />
            </FirstRunGate>
          </AuthContext.Provider>
        </ToastProvider>
      </Tooltip.Provider>
    </ThemeProvider>
  )
}
