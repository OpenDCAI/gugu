// gugu-dev#181 — 哪些群是项目群:聊天页的列表据此把它们拿掉(它们在项目页里,对话页只剩人和用户群)。读端适配边界。
//
// 写端在任务 renderer(session/renderer/features/projects/stores/project-group-chats-bridge.ts):它知道这台电脑和
// 连着的每台机器上的项目各绑了哪个群。类型、键与事件名只从写端 type-import / 照抄字面量;❌ 新建 IPC 桥。
import { useSyncExternalStore } from 'react'
import type {
  PROJECT_GROUP_CHATS_BRIDGE_KEY as WriterKey,
  PROJECT_GROUP_CHATS_EVENT as WriterEvent,
  ProjectGroupChatsBridge,
} from '@/session/renderer/features/projects/stores/project-group-chats-bridge'

const BRIDGE_KEY = '__GUGU_PROJECT_GROUP_CHATS__' satisfies typeof WriterKey
const EVENT = 'gugu:project-group-chats' satisfies typeof WriterEvent
const NONE: ReadonlySet<string> = new Set()
const NO_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map()

/** 桥不在 = 任务 bundle 还没起来(或不是桌面版):还不知道哪些是项目群,一个也不拿掉。形状不对 = 两边构建漂开了,照旧 throw。 */
export function readProjectGroupChats(target: Window | undefined = typeof window === 'undefined' ? undefined : window): ReadonlySet<string> {
  if (!target) return NONE
  const candidate = (target as unknown as Record<string, unknown>)[BRIDGE_KEY]
  if (!candidate) return NONE
  const chatIds = (candidate as Partial<ProjectGroupChatsBridge>).chatIds
  if (!(chatIds instanceof Set)) throw new Error('project group chats bridge is present but malformed')
  return chatIds
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

export function useProjectGroupChats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => readProjectGroupChats(), () => NONE)
}

/** Confirmed project agents from the already-loaded session directories, keyed by project-group chat. */
export function readProjectGroupMembers(target: Window | undefined = typeof window === 'undefined' ? undefined : window): ReadonlyMap<string, readonly string[]> {
  if (!target) return NO_MEMBERS
  const candidate = (target as unknown as Record<string, unknown>)[BRIDGE_KEY]
  if (!candidate) return NO_MEMBERS
  const members = (candidate as Partial<ProjectGroupChatsBridge>).projectMemberIds
  if (!(members instanceof Map)) throw new Error('project group members bridge is present but malformed')
  return members
}

export function useProjectGroupMembers(): ReadonlyMap<string, readonly string[]> {
  return useSyncExternalStore(subscribe, () => readProjectGroupMembers(), () => NO_MEMBERS)
}
