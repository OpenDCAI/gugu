// @vitest-environment jsdom
//
// 聊天列表里 agent 私聊那一行的预览,是从「跨机器的会话目录」里取这个 agent 最近的一条原生消息。
//
// 目录扫描原本写在每一行私聊的 map 里面 —— 也就是**每行重扫一遍整个目录**。于是列表每渲染一次,
// 同一份目录要被重算「行数 × 目录里的会话数」遍。
//
// 判据:目录扫了几次。
// 反例也在:自己扫一次目录,计数会照涨 —— 没有它,上面那条可能只是「计数根本没在数」。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'

const scans = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/session/shared/remote-sessions/session-directory', async () => {
  const actual = await vi.importActual<typeof import('@/session/shared/remote-sessions/session-directory')>(
    '@/session/shared/remote-sessions/session-directory',
  )
  return {
    ...actual,
    // 数一数目录被扫了几次。
    directoryRows: (...args: Parameters<typeof actual.directoryRows>) => {
      scans.count += 1
      return actual.directoryRows(...args)
    },
  }
})

const {
  publishDirectoryDevices,
  updateDeviceSessions,
  removeDeviceSessions,
  directoryRows,
} = await import('@/session/shared/remote-sessions/session-directory')

const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))

let harness: ReturnType<typeof createReactHarness>
let remove: (() => void) | undefined

beforeEach(() => {
  harness = createReactHarness()
  shell.mobile = false
  scans.count = 0
})
afterEach(() => {
  harness.cleanup()
  remove?.()
  removeDeviceSessions('host')
  publishDirectoryDevices([])
})

/** 目录里有多少条会话。 */
const DIRECTORY_SIZE = 40

/** agent 私聊的行数。 */
const AGENT_CHATS = 12

function seedDirectory() {
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  updateDeviceSessions('host', {
    cached: false,
    sessions: Array.from({ length: DIRECTORY_SIZE }, (_unused, index) => ({
      conversationId: `session-${index}`,
      agent: { userId: `own-agent-${index}` },
      lastInteractedAt: `2026-10-31T09:00:${String(index % 60).padStart(2, '0')}Z`,
    })),
  } as never)
}

function agentChats(): ChatItem[] {
  return Array.from({ length: AGENT_CHATS }, (_unused, index) => ({
    id: `dm-${index}`,
    kind: 'dm',
    peer_user_id: `own-agent-${index}`,
    unread_count: 0,
    last_message_at: null,
  })) as unknown as ChatItem[]
}

it('renders many agent rows against one directory scan, not one per row', async () => {
  remove = installOwnedAgentEntry({ open: () => true, owns: (id) => id.startsWith('own-agent-') })
  seedDirectory()

  function Fixture() {
    const rows = useNativeAgentChats(agentChats())
    return <div>{rows.length}</div>
  }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe(String(AGENT_CHATS))

  // 目录只该扫一次(不管有几行 agent 私聊)。
  expect(scans.count).toBeLessThanOrEqual(1)
})

it('the counter does see a scan that really happens', async () => {
  remove = installOwnedAgentEntry({ open: () => true, owns: (id) => id.startsWith('own-agent-') })
  seedDirectory()

  // 自己扫一遍 ⇒ 计数该涨。没有这一条,上面那条可能只是「计数根本没在数」。
  directoryRows([{ device_id: 'host', is_online: true, capabilities: {} } as Device], {})
  expect(scans.count).toBeGreaterThan(0)
})
