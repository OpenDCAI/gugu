// @vitest-environment jsdom
//
// 手机壳没有会话页宿主桥。共享转录的 ChatContext 第一次建时会预取 issue 图标(rpc.integrations.list),
// 桥缺席时 rpc 的桩同步抛 —— 以前那一抛越过 catch,第一次 getSharedChatContext() 就抛,
// 手机上第一次展开的思考行一直空白、收起再展开才画出来(2026-10-02 真机:innerHTML 0 → 3459)。
import { describe, expect, it, vi } from 'vitest'

Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn().mockResolvedValue([]) } })

describe('没有任务页宿主桥时,共享 ChatContext 第一次就建得出来', () => {
  it('第一次调用不抛,第二次拿到同一个', async () => {
    expect((window as unknown as { electronAPI?: unknown }).electronAPI, 'a bridge is installed, so this proves nothing').toBeUndefined()
    const { getSharedChatContext } = await import('../../../apps/desktop/src/session/renderer/lib/chat/shared-chat-context')
    const first = getSharedChatContext()
    expect(first).toBeTruthy()
    expect(getSharedChatContext()).toBe(first)
  })
})
