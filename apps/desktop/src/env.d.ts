/// <reference types="vite/client" />

declare const __GUGU_BUILD_TAG__: string
declare const __GUGU_TEST_NOTES__: string
declare const __GUGU_CLOUD_COMPUTER_URL__: string

interface Window {
  electronAPI?: {
    // @@@task-fusion (#2802) — 任务页渲染层用的那几个成员。preload 早就暴露了它们
    // (contextBridge 里的 invoke / eventSend / eventOn / getPathForFile / requestWirePort),
    // 这里是它们的**唯一**声明。
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    eventSend: (channel: string, data: unknown) => void
    eventOn: (channel: string, cb: (data: unknown) => void) => () => void
    getPathForFile: (file: File) => string
    requestWirePort: (channel: string) => Promise<void>
    selectDirectory: () => Promise<string | null>
    selectFile: () => Promise<string | null>
    checkForUpdates: () => Promise<unknown>
    updateState: () => Promise<unknown>
    downloadUpdate: () => Promise<unknown>
    installUpdate: () => Promise<unknown>
    /** @@@5758 更新说明由主进程代取 —— 渲染层 origin 跨源,下载站不发 CORS 头。 */
    fetchChangelog: () => Promise<unknown>
    getAppVersion: () => Promise<string>
    getFeedbackLogTail: () => Promise<unknown>
    getAgentCreationTools: () => Promise<unknown>
    openAgentRuntime: (agentUserId: string) => Promise<unknown>
    writeClipboardText: (value: string) => Promise<boolean>
    // 内联 import(...) 而不是顶部 import:这是全局声明文件,顶部 import 会把它变成模块,
    // `interface Window` 就不再是全局增补。写成字面量联合会跟 RendererCommandDomain 悄悄漂。
    rendererCmdResult: (
      domain: import('./lib/rendererCommandProtocol').RendererCommandDomain,
      reqId: string,
      result: unknown
    ) => void
    rendererCmdReady: (
      domain: import('./lib/rendererCommandProtocol').RendererCommandDomain
    ) => void
    setBadge: (count: number) => void
    setTrayBadgeEnabled: (enabled: boolean) => void
    syncResolvedLocale: (locale: 'zh-CN' | 'en-US') => Promise<void>
    /** @@@window-tone 渲染层把主题真值告诉主进程,主进程据此改写无边框窗口的底色。 */
    syncWindowTone?: (tone: 'light' | 'dark') => void
    /** mac 原生外观跟随偏好(主进程照抄成 nativeTheme.themeSource),答回此刻的真实明暗;同步失败为 null。 */
    syncThemePreference?: (preference: 'light' | 'dark' | 'system') => Promise<'light' | 'dark'>
    relaunchApp: () => Promise<void>
    onAppForeground: (callback: () => void) => () => void
    subscribeAppActive: (callback: (active: boolean) => void) => () => void
    showNotification: (payload: { title: string; body?: string; chatId?: string | null }) => Promise<unknown>
    getLocalDeviceSelfSnapshot: () => Promise<unknown>
    releaseOwnedAgentLocalFootprint: (agentUserId: string) => Promise<unknown>
    renameOwnedAgentLocalFootprint: (agentUserId: string, name: string) => Promise<boolean>
    writeHumanAuthSession: (session: unknown) => Promise<void>
    clearHumanAuthSession: (reason: 'signed-out' | 'lost') => Promise<void>
    notifyDeviceCommandsChanged: () => void
    notifyOwnedAgentsChanged: () => void
  }
  // @@@host-system-languages — 桌面宿主注入的真实系统语言列表(app.getPreferredSystemLanguages());
  // web/移动端为 undefined,那里 navigator.languages 本身就是系统语言。
  /** 「设置 → 聊天渠道 → 微信」;只有桌面版有(preload 暴露),web / 手机上没有。 */
  guguHostLocale?: {
    /** preload 发起的真实宿主语言请求,首帧解析「跟随系统」前等待它。 */
    systemLanguages: Promise<readonly string[]>
    /** 重新向 main 问一次(宿主语言运行期变化时用)。 */
    readSystemLanguages: () => Promise<readonly string[]>
  }
  // @@@822 frameless 自绘标题栏的窗口控制桥(Windows/Linux);Mac/web 下为 undefined。
  desktopWindow?: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    /** Windows 标题栏菜单的编辑 / 缩放 / 全屏命令(清单见 electron/window-menu-commands.ts)。 */
    runMenuCommand?: (command: import('../shared/window-menu-commands').WindowMenuCommand) => void
    getChromeLabels?: () => Promise<{
      minimize: string
      maximize: string
      restore: string
      close: string
    }>
    onChromeLabelsChange?: (callback: (labels: {
      minimize: string
      maximize: string
      restore: string
      close: string
    }) => void) => () => void
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
    /** 窗口底层材质的判定(主进程读系统信号,见 shared/window-material.ts)。 */
    getMaterial?: () => Promise<import('../shared/window-material').WindowMaterial>
    onMaterialChange?: (callback: (material: import('../shared/window-material').WindowMaterial) => void) => () => void
  }
}
