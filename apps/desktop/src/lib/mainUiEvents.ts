// 主进程 → 界面的事件:主进程按这里的定义发(main.ts 的 sendUiEvent),preload 按同一份定义转成 window 上同名键的
// UI_EVENTS。通道名只写在这一处 —— 任一头拼错、或改回手写字符串,都当场编译不过(❌ 两头各写一遍裸字符串)。
// 载荷类型能写的写上;渲染层监听方读 detail 时仍是自己 cast(那是下一步)。
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import type { AgentStreamPayload } from '@gugu/core/shared/types/agentStream'
import { defineEvent, type EventDefinition } from '../session/shared/lib/ipc/events'
import type { UI_EVENTS } from './uiEvents'

export const MAIN_UI_EVENTS = {
  updateReady: defineEvent<void>('update-ready'),
  updateStatus: defineEvent<unknown>('update-status'),
  notificationClicked: defineEvent<{ chatId: string | null }>('notification-clicked'),
  // @@@acp-stream (#966 gate A) - ACP agent 流式输出。
  agentStream: defineEvent<AgentStreamPayload>('agent-stream'),
  // @@@sessionpage fail-loud VISIBLE (#6) - 会话页 agent 投递终态失败 → toast。
  sessionpageDeliverFailed: defineEvent<{ agentUserId: string; error: string }>('sessionpage-deliver-failed'),
  // @@@sessionpage otty-state - 被人类 block 的 agent 里最急的那一种 → 最左栏「消息」那颗点。
  sessionpageAttention: defineEvent<AgentAttention>('sessionpage-attention'),
  // @@@sessionpage 分享 - 会话页头部的分享入口,由 gugu 渲染层用自己的通讯录打开 SharePosterDialog;没绑 agent 时说明原因。
  sessionpageShareAgent: defineEvent<unknown>('sessionpage-share-agent'),
  sessionpageShareAgentUnavailable: defineEvent<string>('sessionpage-share-agent-unavailable'),
  // #6091 会话页改了自有 agent 的名字:通讯录缓存着 display_name,叫它刷新。
  ownedAgentRenamed: defineEvent<{ agentUserId: string; displayName: string }>('owned-agent-renamed'),
  sessionpageOpenFeedback: defineEvent<void>('sessionpage-open-feedback'),
  // 主窗看不看得见(最小化、收进托盘 = false;恢复、显示 = true)。主窗关了节流,document.hidden 不跟着变(main.ts)。
  windowSeen: defineEvent<boolean>('window-seen'),
} as const satisfies { readonly [K in keyof typeof UI_EVENTS]?: EventDefinition<unknown> }
