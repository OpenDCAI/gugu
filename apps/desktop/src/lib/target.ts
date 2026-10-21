// @@@web-target-gate - build-time deployment target for the renderer (electron | web).
// 只表达「这份渲染层是按哪个目标构建的」。❌ 别再拿它当「会话页能不能用」的判据:
// 会话页在两个目标下都渲染(@@@task-web-host),web 由无头宿主经 WebSocket 供后端。
// Defined in vite.config.mts; absent (unit tests/jsdom) = electron, matching the desktop default.
declare const __GUGU_TARGET__: string | undefined

export const guguTarget: string =
  typeof __GUGU_TARGET__ !== 'undefined' ? __GUGU_TARGET__ : 'electron'

export const isWebTarget = guguTarget === 'web'
