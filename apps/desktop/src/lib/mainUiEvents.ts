// 主进程 → 界面的事件:主进程按这里的定义发(main.ts 的 sendUiEvent),preload 按同一份定义转成 window 上同名键的
// UI_EVENTS。通道名只写在这一处 —— 任一头拼错、或改回手写字符串,都当场编译不过(❌ 两头各写一遍裸字符串)。
// 载荷类型能写的写上;渲染层监听方读 detail 时仍是自己 cast(那是下一步)。
import { defineEvent, type EventDefinition } from '../session/shared/lib/ipc/events'
import type { UI_EVENTS } from './uiEvents'

export const MAIN_UI_EVENTS = {
  updateReady: defineEvent<void>('update-ready'),
  updateStatus: defineEvent<unknown>('update-status'),
  notificationClicked: defineEvent<{ chatId: string | null }>('notification-clicked'),
  // @@@sessionpage 分享 - 会话页头部的分享入口,由 gugu 渲染层用自己的通讯录打开 SharePosterDialog;没绑 agent 时说明原因。
  sessionpageShareAgent: defineEvent<unknown>('sessionpage-share-agent'),
  sessionpageShareAgentUnavailable: defineEvent<string>('sessionpage-share-agent-unavailable'),
  // #6091 会话页改了自有 agent 的名字:通讯录缓存着 display_name,叫它刷新。
  ownedAgentRenamed: defineEvent<{ agentUserId: string; displayName: string }>('owned-agent-renamed'),
  sessionpageOpenFeedback: defineEvent<void>('sessionpage-open-feedback'),
} as const satisfies { readonly [K in keyof typeof UI_EVENTS]?: EventDefinition<unknown> }
