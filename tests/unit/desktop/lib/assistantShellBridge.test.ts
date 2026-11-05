import { describe, expect, it, vi } from 'vitest'
import { publishAssistantShell, readAssistantShellBridge, installAssistantShellBridge, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'

const base: AssistantShellSnapshot = {
  cloudAvailable: true,
  canHostHere: true,
  cloud: null,
  loadError: null,
  assistant: null,
  assistantState: 'loading',
  member: null,
  preparing: false,
  ownerName: 'owner',
  chatId: null,
  home: null,
  setup: null,
}

describe('assistantShellBridge publish (#7199)', () => {
  it('它住哪、引导走到哪一步变了也要通知(搬家、安好家之后接着连应用)', () => {
    const w = {} as Window
    installAssistantShellBridge(w)
    const bridge = readAssistantShellBridge(w)!
    publishAssistantShell(base)
    const listener = vi.fn()
    const off = bridge.subscribe(listener)
    publishAssistantShell({ ...base, home: { kind: 'computer', deviceId: 'mac', thisDevice: true, label: 'MacBook', online: true, known: true } })
    expect(listener).toHaveBeenCalledTimes(1)
    publishAssistantShell({ ...base, home: { kind: 'computer', deviceId: 'mac', thisDevice: true, label: 'MacBook', online: true, known: true }, setup: 'connect' })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it('认它的读数变了(还在读 → 读不到)、私聊认出来了,会话页都要收到;一模一样的不重复通知', () => {
    const w = {} as Window
    installAssistantShellBridge(w)
    const bridge = readAssistantShellBridge(w)!
    publishAssistantShell(base)
    const listener = vi.fn()
    const off = bridge.subscribe(listener)
    publishAssistantShell({ ...base })
    expect(listener).toHaveBeenCalledTimes(0)
    publishAssistantShell({ ...base, assistantState: 'unreadable' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(bridge.getSnapshot()?.assistantState).toBe('unreadable')
    publishAssistantShell({ ...base, assistantState: 'unreadable', chatId: 'chat-1' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(bridge.getSnapshot()?.chatId).toBe('chat-1')
    off()
  })
})
