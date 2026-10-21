import type { CSSProperties } from 'react'

// 手机上这一槽位是一整页(#6418 会话/群设置先这么做):盖住会话页头(否则叠出两个页头 / 两个返回),顶边让开安全区
// (同 MainLayout)。成员、公告、工作区、历史同一个外壳(RightPanel);里面的面板不定宽,撑满这一页。
export const rightPanelMobilePageStyle: CSSProperties = {
  position: 'fixed', right: 0, top: 'env(safe-area-inset-top)', bottom: 0, width: '100%',
  background: 'var(--bg-primary)', zIndex: 'var(--z-modal)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
