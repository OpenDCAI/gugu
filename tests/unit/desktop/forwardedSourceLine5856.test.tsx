// @vitest-environment jsdom
//
// @@@5856 转发留痕 ——「跨线引用别处的内容时在界面上留痕(「引自:某某线」),让人看得见发生了搬运、
// 能当场喊停」(product spec「agent 在话题里能做什么」)。
//
// 钉三条会被悄悄做坏的地方:
//   ① 出处读得到时,那一格必须真的说出线名 —— 只写「转发」等于没留痕,人看不出东西是从哪儿搬来的。
//   ② 出处读不到(chat.forwarded_source 是 SECURITY INVOKER,读者看不见来源线时返回空)⇒ 退回
//      只显「转发」,❌ 不渲染成「未知来源」:那和「你无权看见」在用户那里不是一回事。
//   ③ 换一条消息的那一帧,❌ 不许把上一条的出处挂到这一条头上(#3922 那一族的状态串台)。
//      判据自带反例:两条消息各有各的出处,切过去当场就得是新的那条。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

const rpc = vi.fn()
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: (...args: unknown[]) => rpc(...args) },
  identityDb: { from: vi.fn() },
  dataClient: {},
}))

const { MessageMetaRow } = await import('../../../apps/desktop/src/components/chat/MessageMetaRow')
const { resetForwardedSourceCacheForTests } = await import('../../../apps/desktop/src/lib/forwardedSource')

function sourceRow(name: string | null, kind = 'group') {
  return { data: [{ source_chat_id: 'chat-src', source_chat_kind: kind, source_chat_name: name }], error: null }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  resetForwardedSourceCacheForTests()
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

async function renderRow(forwardedFromMessageId: string | null) {
  await renderWithAppProviders(
    harness,
    createNode(MessageMetaRow, { targetingLabels: [], forwardedFromMessageId, viaApp: null, viaAppSender: null }),
  )
  // 出处是异步取的:合批的 microtask + rpc 的 then,都冲干净再断言。
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

const badgeText = () =>
  harness.container.querySelector('[data-testid="message-forwarded-badge"]')?.textContent ?? ''

describe('转发留痕 ——「引自:某某线」', () => {
  it('读得到出处时说出线名', async () => {
    rpc.mockResolvedValue(sourceRow('发版协调'))
    await renderRow('msg-1')
    expect(rpc).toHaveBeenCalledWith('forwarded_source', { p_message_id: 'msg-1' })
    expect(badgeText()).toContain('引自：发版协调')
  })

  it('读者看不见来源线(RLS 返回空)⇒ 退回只显「转发」,❌ 不编「未知来源」', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await renderRow('msg-2')
    expect(badgeText()).toBe('↪ 转发')
    for (const fake of ['未知', '引自']) expect(badgeText()).not.toContain(fake)
  })

  it('来源线没有名字(私聊)时同样退回只显「转发」', async () => {
    rpc.mockResolvedValue(sourceRow(null, 'dm'))
    await renderRow('msg-3')
    expect(badgeText()).toBe('↪ 转发')
  })

  it('同一个组件换一条消息:新出处还没到的那一帧,❌ 不许挂着上一条的出处', async () => {
    // 不卸载重建 —— 串台只在**同一个组件实例换主体**时发生,重建会把 bug 一起重建没了。
    let releaseB: (() => void) | null = null
    rpc.mockImplementation(async (_fn: string, args: { p_message_id: string }) => {
      if (args.p_message_id === 'msg-a') return sourceRow('甲线')
      await new Promise<void>((resolve) => { releaseB = resolve })
      return sourceRow('乙线')
    })
    await renderRow('msg-a')
    expect(badgeText()).toContain('引自：甲线')

    await renderRow('msg-b')
    // msg-b 的往返还挂着:此刻退回只显「转发」,而不是把甲线的出处安到乙消息头上。
    expect(badgeText()).toBe('↪ 转发')

    await act(async () => { releaseB?.(); await Promise.resolve(); await Promise.resolve() })
    expect(badgeText()).toContain('引自：乙线')
  })

  it('读失败 ❌ 不进缓存 —— 一次抖动不许让这条消息的「引自」永远消失', async () => {
    rpc.mockRejectedValueOnce(new Error('network hiccup'))
    await renderRow('msg-flaky')
    expect(badgeText()).toBe('↪ 转发')
    expect(rpc).toHaveBeenCalledTimes(1)

    // 重挂一次:如果失败被缓存成「没有出处」,下面这次就不会再发请求,出处永远回不来。
    harness.cleanup()
    harness = createReactHarness()
    rpc.mockResolvedValue(sourceRow('发版协调'))
    await renderRow('msg-flaky')
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(badgeText()).toContain('引自：发版协调')
  })

  it('反例:读成功(哪怕结果是「没有出处」)要进缓存,❌ 不许每次重绘都再问一遍', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await renderRow('msg-none')
    expect(rpc).toHaveBeenCalledTimes(1)
    harness.cleanup()
    harness = createReactHarness()
    await renderRow('msg-none')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('不是转发的消息:整行不渲染', async () => {
    await renderRow(null)
    expect(harness.container.querySelector('[data-testid="message-forwarded-badge"]')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
