// @@@share-popover-dismiss 分享浮层锚点的**唯一**名字。
//
// 分享按钮长在会话页渲染层(share-agent-button.tsx),浮层由咕咕渲染层画(AgentSharePopover)——
// 两棵 React 树,但并入本体后是同一个 document(EmdashSessionFrame 挂 light DOM,没有 shadow root),
// 所以浮层能直接拿这个属性把自己钉在真按钮上。
//
// 名字写在这里、两侧都 import:❌ 任何一侧手写字符串。改错一边不会报错,只会让浮层悄悄退回
// 「贴窗口右缘」的兜底位置 —— 那正是 owner 实机看到的「漂在右侧栏之上」。
export const SESSIONPAGE_SHARE_ANCHOR_ATTRIBUTE = 'data-sessionpage-share-anchor'

export const SESSIONPAGE_SHARE_ANCHOR_SELECTOR = `[${SESSIONPAGE_SHARE_ANCHOR_ATTRIBUTE}]`
