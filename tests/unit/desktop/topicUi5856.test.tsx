// @vitest-environment jsdom
//
// @@@5856 话题(topic)展示层的判据 —— product spec。
// 覆盖两条承重线:
//   1. 「可见 / 参与 / 通知是三件事」在锚点卡上真的看得出来(is_participant=false ⇒ 「只看得见」);
//      判据能判假 —— 同一份数据把 is_participant 翻成 true,那条断言必须反过来。
//   2. useTopicsOfChat 的竞态守卫:切线之后,上一条线的慢响应 ❌ 不许落进新线的状态。
import { topicHistoryStub } from '../../support/chatWindowStub'
import { readFile } from 'node:fs/promises'
import { act, createElement, useEffect, useCallback, useState } from 'react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, clickElement, deferred, message, renderWithAppProviders, typeInto } from '../../support/testHarness'

const listTopicsOfChat = vi.fn<(sourceChatId: string) => Promise<TopicSummary[]>>()
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: (sourceChatId: string) => listTopicsOfChat(sourceChatId),
  },
}))

const { useTopicsOfChat, topicsSourceChatId } = await import('../../../apps/desktop/src/hooks/useTopics')
const { TopicAnchorCard } = await import('../../../apps/desktop/src/components/chat/TopicAnchorCard')
const { TopicBreadcrumb } = await import('../../../apps/desktop/src/components/chat/TopicBreadcrumb')
const { TopicSplitPane } = await import('../../../apps/desktop/src/components/chat/TopicSplitPane')
const { installedExtensionsStore } = await import('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { EXTENSION_API_VERSION, parseExtensionManifest } = await import('../../../apps/desktop/src/session/shared/extensions/manifest')
const { UI_EVENTS } = await import('../../../apps/desktop/src/lib/uiEvents')
const { quotePrefixOf, latestTopicSourceIdOf, canSourceTopic, maxTopicSplitWidthForAvailableWidth, TOPIC_SPLIT_MIN_WIDTH, TOPIC_SPLIT_MAX_WIDTH } = await import('../../../apps/desktop/src/components/chat/topicSplitModels')
const { defaultHistoryTab, pageHistoryTopics, HISTORY_TOPIC_PAGE } = await import('../../../apps/desktop/src/components/historyPanelModels')
const { chatDisplayName } = await import('@gugu/core/shared/ui/chatModels')
const { withSourceLineCandidates } = await import('../../../apps/desktop/src/lib/mention')

function topic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    chat_id: 'topic-1',
    name: '分片下载失败',
    source_message_id: 'msg-1',
    creator_user_id: 'user-1',
    last_message_at: '2026-09-18T00:00:00.000Z',
    message_count: 7,
    participant_count: 3,
    is_participant: true,
    ...overrides,
  }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  listTopicsOfChat.mockReset()
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('TopicAnchorCard 把「可见 / 参与 / 通知」的第三件显形', () => {
  it('非参与者的话题挂出「只看得见」，参与者的不挂', async () => {
    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({ is_participant: false })], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    const observer = harness.container.querySelector('[data-testid="topic-anchor-observer"]')
    // 判据能判假:同一份数据只翻 is_participant,下面那次渲染必须拿不到这枚标。
    expect(observer).not.toBeNull()
    expect(observer?.textContent).toBe('只看得见')
    expect(observer?.getAttribute('title')).toBe('你看得见这条话题，但它的消息不会通知你')
    expect(harness.container.querySelector('[data-testid="topic-anchor-row"]')?.getAttribute('data-topic-participant')).toBe('false')

    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({ is_participant: true })], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-observer"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('只看得见')
    expect(harness.container.querySelector('[data-testid="topic-anchor-row"]')?.getAttribute('data-topic-participant')).toBe('true')
  })

  it('一条来源消息长出的多条话题各渲染一行，点击回传话题 chat_id', async () => {
    const onOpen = vi.fn()
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ chat_id: 'topic-a' }), topic({ chat_id: 'topic-b', name: '网关限流' })],
        isMine: false,
        sourceContent: null,
        onOpen,
      }),
    )
    const rows = harness.container.querySelectorAll('[data-testid="topic-anchor-row"]')
    expect(rows.length).toBe(2)
    expect(harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toContain('7 条')
    await clickElement(rows[1] as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('topic-b')
  })

  it('没有话题时整块不渲染（❌ 不给消息底下留一条空壳）', async () => {
    await harness.render(createNode(TopicAnchorCard, { topics: [], isMine: false, sourceContent: null, onOpen: vi.fn() }))
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')).toBeNull()
  })

  it('#6010 每条摘要显示自身参与人数，与消息数和是否参与无关，人数变化后更新', async () => {
    const onOpen = vi.fn()
    const render = (count: number) => harness.render(createNode(TopicAnchorCard, {
      topics: [topic({ participant_count: count, message_count: 33, is_participant: false }),
        topic({ chat_id: 'topic-2', name: '另一条话题', participant_count: 1, message_count: 0 })],
      isMine: false, sourceContent: null, onOpen,
    }))
    for (const count of [3, 4, 2, 0]) {
      await render(count)
      const rows = harness.container.querySelectorAll('[data-testid="topic-anchor-row"]')
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-participant-count"]')?.textContent).toBe(`${count} 人参与`)
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toContain('33 条')
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-observer"]')).not.toBeNull()
      expect(rows[1]?.querySelector('[data-testid="topic-anchor-participant-count"]')?.textContent).toBe('1 人参与')
      expect(rows[0]?.getAttribute('aria-label')).toContain(`${count} 人参与`)
    }
    await clickElement(harness.container.querySelector('[data-topic-id="topic-2"]') as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('topic-2')
  })
})

// @@@5856 owner 2026-09-19 看了实机:旧样式在 UI 上不成立
// 「话题只是某一条消息的附件的思路你懂不,之前给你发的 discord 你倒是参考啊」。
describe('锚点是那条消息的附件,所以跟它的气泡同一侧', () => {
  it('自己发的消息 → 锚点贴右;别人发的 → 贴左', async () => {
    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({})], isMine: true, sourceContent: null, onOpen: vi.fn() }),
    )
    // 上一版恒定左对齐、整行铺开:来源消息在右边时,锚点跑到屏幕另一侧,读者连不起来它挂在谁身上。
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')?.getAttribute('data-topic-anchor-side')).toBe('mine')

    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({})], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')?.getAttribute('data-topic-anchor-side')).toBe('theirs')
  })

  it('那一行说清「谁开的 · 什么时候有动静」;都没有就明说还没有人说话,❌ 不留一行空的', async () => {
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ creator_user_id: 'u1', last_message_at: '2026-09-18T12:00:00.000Z' })],
        isMine: false,
        sourceContent: '来源那句话',
        onOpen: vi.fn(),
        memberProfiles: { u1: { displayName: '林工' } },
      }),
    )
    const meta = harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent ?? ''
    expect(meta).toContain('林工')

    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ creator_user_id: null, last_message_at: null, message_count: 0 })],
        isMine: false,
        sourceContent: '来源那句话',
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toBe('还没有人说话')
  })

  // @@@5856 owner 2026-09-19 对着实机:「你不感觉这个像是个文字重复吗?这一段文字,是你故意的」。
  // 话题名默认截自来源消息的开头,锚点又挂在那条消息底下 ⇒ 同一句话连着出现两遍。
  // 判据两面都要:没改过名不许重复,改过名必须写出来(否则「永远只写『话题』」也能过)。
  it('名字还是从来源消息截出来的 ⇒ 锚点不把那句话念第二遍;改过名才写名字', async () => {
    const source = '分片下载在弱网下会整包重来，这个得单独拉一条线捋'
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: source })],
        isMine: true,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('话题')
    expect(harness.container.textContent).not.toContain('整包重来')

    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: '弱网续传' })],
        isMine: true,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('弱网续传')
  })

  it('超过 40 字的来源消息:名字带省略号,客户端这份镜像照样认得出它没被改过', async () => {
    const source = `${'长'.repeat(60)}\n第二行不算`
    const cut = `${'长'.repeat(40)}…`
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: cut })],
        isMine: false,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('话题')
  })

  it('取不到来源正文时宁可把名字写出来,❌ 不隐瞒', async () => {
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: '某条话题' })],
        isMine: false,
        sourceContent: null,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('某条话题')
  })
})

// @@@5856 owner 2026-09-19 实测:「这条线也拖不动啊」。
describe('分栏那条分割线得真能拖', () => {
  it('常见窗口宽度下,上限必须**高于**下限 —— 相等就等于一格都拖不动', () => {
    // 1280 宽的窗口上聊天区实宽约 980。上一版给主聊天区留的是 740(那是 useMessageColumnMinWidth
    // 注释里「中栏 380 + 右栏 360」的**和**,不是中栏的保留额),算出来上限 280 = 下限:
    // 拖拽照常开始(data-dragging 翻 true)、宽度纹丝不动。
    expect(maxTopicSplitWidthForAvailableWidth(980)).toBeGreaterThan(TOPIC_SPLIT_MIN_WIDTH)
    // 窗口再宽也不超过它自己的天花板。
    expect(maxTopicSplitWidthForAvailableWidth(4000)).toBe(TOPIC_SPLIT_MAX_WIDTH)
    // 阴控:窗口真的窄到留不下主聊天区时,才退回「只剩下限」这一档。
    expect(maxTopicSplitWidthForAvailableWidth(600)).toBe(TOPIC_SPLIT_MIN_WIDTH)
  })
})

describe('TopicBreadcrumb:双向连接上行的那一半 + 来源消息被删的状态', () => {
  it('话题名与「引自哪一句」都显,且不出现一颗跳回来源的废按钮', async () => {
    await harness.render(
      createNode(TopicBreadcrumb, {
        topicName: '分片下载失败',
        sourceMessagePreview: '下载到 60% 就断',
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-name"]')?.textContent).toBe('分片下载失败')
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-preview"]')?.textContent)
      .toBe('引自：下载到 60% 就断')
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-deleted"]')).toBeNull()
    // @@@5856 话题只在来源线旁边开分栏 ⇒ 来源线就在左边,一颗「回到来源」的按钮点了等于没点。
    // ❌ 不许留着它(dead control)。
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source"]')).toBeNull()
  })

  it('来源消息被硬删时说出来，❌ 不静默显示成正常', async () => {
    await harness.render(
      createNode(TopicBreadcrumb, { topicName: '分片下载失败', sourceMessagePreview: null }),
    )
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-preview"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-deleted"]')?.textContent)
      .toBe('来源消息已被删除，这条话题继续存在')
  })

  it('还没读到 / 读到了但这个人看不见:那一行什么都不说，❌ 不谎报「已删除」', async () => {
    for (const preview of ['pending', 'unreadable'] as const) {
      await harness.render(createNode(TopicBreadcrumb, { topicName: 'x', sourceMessagePreview: preview }))
      expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-deleted"]')).toBeNull()
      expect(harness.container.querySelector('[data-testid="topic-breadcrumb-source-preview"]')).toBeNull()
    }
  })
})

describe('TopicSplitPane 是分栏，不是话题的开关', () => {
  const baseProps = {
    topic: { chatId: 'topic-1', name: '分片下载失败' },
    messages: [],
    loading: false,
    memberProfiles: {},
    memberReadSeqs: {},
    visibleChats: [],
    sourceMessagePreview: 'pending',
    onOpenFile: vi.fn(),
    onDownloadFile: vi.fn(),
    onSend: vi.fn(async () => {}),
    onSendAttachments: vi.fn(async () => {}),
    onClose: vi.fn(),
    currentUserId: 'user-1',
    history: topicHistoryStub(),
    mentionMembers: [],
  } satisfies Parameters<typeof TopicSplitPane>[0]

  const receiptProps = {
    ...baseProps,
    messages: [message({ id: 'topic-own-message', is_mine: true, seq: 10, to_user_ids: ['read', 'unread', 'source-only'], readers: ['read'] })],
    memberReadSeqs: { read: 0, unread: 0 },
    memberProfiles: {
      read: { id: 'read', displayName: '话题已读成员', avatar: null, email: null, type: 'agent' as const, role: 'member' as const },
      unread: { id: 'unread', displayName: '话题未读成员', avatar: null, email: null, type: 'human' as const, role: 'member' as const },
      'source-only': { id: 'source-only', displayName: '仅来源群成员', avatar: null, email: null, type: 'human' as const, role: 'member' as const },
    },
  }

  // 2026-09-24 shuxue:「我在 topic 里面点不开你发的附件」。分栏复用 MessageList 却没接 onOpenFile ⇒
  // 文件卡的按钮点了什么都不发生(主线那边是接了的)。反例:不接时确实点不出任何调用 —— 证明这一格判得出缺失。
  // 用 pdf:png 按扩展名一律内联成图(不看 [Kind]),不画文件卡。
  it('分栏里的文件卡点得开,走的是传进来的 onOpenAttachment', async () => {
    const content = ['[附件] 报告.pdf', '[URL] https://example.test/chat-media/a.pdf', '[Size] 94567', '[Kind] file'].join('\n')
    const attachmentProps = { ...baseProps, messages: [message({ id: 'att-1', content, content_type: 'attachment' })] }
    const onOpenAttachment = vi.fn()
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...attachmentProps, onOpenAttachment }))
    const card = harness.container.querySelector('[data-testid="topic-split-pane"] button[aria-label="报告.pdf"]') as HTMLElement
    expect(card, '分栏里没画出文件卡').toBeTruthy()
    await clickElement(card)
    expect(onOpenAttachment).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'url', url: 'https://example.test/chat-media/a.pdf' }, fileName: '报告.pdf' }), attachmentProps.messages[0])
  })

  it('点击话题已读环显示该消息的已读/未读名单，排除只在来源群里的成员', async () => {
    await renderWithAppProviders(harness, createNode(TopicSplitPane, receiptProps))
    await clickElement(harness.container.querySelector('[data-testid="message-read-receipt"]') as HTMLElement)
    const panel = document.querySelector('[data-testid="message-read-receipt-panel"]')
    expect(panel?.textContent).toContain('话题已读成员')
    expect(panel?.textContent).toContain('话题未读成员')
    expect(panel?.textContent).not.toContain('仅来源群成员')
    expect(panel?.textContent).toContain('已读 1')
    expect(panel?.textContent).toContain('未读 1')

    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...receiptProps, memberReadSeqs: { read: 0, unread: 10 },
    }))
    expect(document.querySelector('[data-testid="message-read-receipt-panel"]')?.textContent).toContain('已读 2')
    expect(document.querySelector('[data-testid="message-read-receipt-panel"]')?.textContent).toContain('未读 0')
  })

  it('换话题关闭回执名单，切回原话题也不恢复旧弹层', async () => {
    await renderWithAppProviders(harness, createNode(TopicSplitPane, receiptProps))
    await clickElement(harness.container.querySelector('[data-testid="message-read-receipt"]') as HTMLElement)
    expect(document.querySelector('[data-testid="message-read-receipt-panel"]')).not.toBeNull()
    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...receiptProps, topic: { chatId: 'topic-other', name: '另一话题' }, messages: [],
    }))
    expect(document.querySelector('[data-testid="message-read-receipt-panel"]')).toBeNull()
    await renderWithAppProviders(harness, createNode(TopicSplitPane, receiptProps))
    expect(document.querySelector('[data-testid="message-read-receipt-panel"]')).toBeNull()
  })

  // R A/B 10-06: a topic's App panel covers the topic's list, and its gugu.showMessage of a topic line moved nothing —
  // no scroll, no flash, no toast (both builds). Control (b22032f777): the panel stays and no row flashes.
  it('gugu.showMessage of a line in this topic: the App panel gives the list back, and that line flashes', async () => {
    const originalCheckVisibility = HTMLElement.prototype.checkVisibility
    const originalScrollTo = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.checkVisibility = () => false // jsdom has none; an unseen slot claims no page
    HTMLElement.prototype.scrollTo = () => {} // jsdom lays nothing out: where the list goes is the A/B's reading
    try {
      const messages = ['t-1', 't-2', 't-3'].map((id, index) => message({ id, seq: index + 1, content: `line ${id}` }))
      await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, messages }))
      await clickElement(harness.container.querySelector('[data-testid="topic-split-workspace-toggle"]') as HTMLElement)
      expect(harness.container.querySelector('[data-testid="topic-split-workspace"]'), 'the App panel is open').toBeTruthy()
      await act(async () => {
        window.dispatchEvent(new CustomEvent('gugu:app-show-message', { detail: { chatId: 'topic-1', messageId: 't-1' } }))
      })
      expect(harness.container.querySelector('[data-testid="topic-split-workspace"]'), 'the panel gave the list back').toBeNull()
      expect(harness.container.querySelector('[data-msg-id="t-1"]')?.className).toContain('msg-src-flash')
      expect(harness.container.querySelector('[data-msg-id="t-2"]')?.className).not.toContain('msg-src-flash')
    } finally {
      HTMLElement.prototype.checkVisibility = originalCheckVisibility
      HTMLElement.prototype.scrollTo = originalScrollTo
    }
  })

  it('分栏的输入框**就是**主线那一份 InputArea,❌ 不是另造的一个', async () => {
    // @@@5856 owner 2026-09-19 实测:「输入框没有发送键参考一下左边输入框,应该是一致的,
    // 也是因为你造了一个额外的输入框,导致 @ 等功能失效了」。
    // 自造的那份症状不是「长得不一样」,是**功能悄悄少了一半**——发送键、@ 候选弹窗、草稿、附件,
    // 全是原件早就解决过的问题,重写一份把它们统统退回未解决态,而且不报任何错。
    // 所以这一格钉的是「用的是同一个组件」,而不是「自造的那份也有发送键」。
    const source = await readFile('apps/desktop/src/components/chat/TopicSplitPane.tsx', 'utf8')
    expect(source).toContain("import { InputArea } from './InputArea'")
    expect(source).not.toContain('function TopicComposer')
    expect(source).not.toContain('<textarea')

    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...baseProps,
      mentionMembers: [{ id: 'agent-9', name: '小柯', type: 'agent' as const }],
    }))
    // 渲染出来的就是 InputArea 自己那个 textarea。
    // —— 但它报的是**副栏**的 test id:同一扇窗里两个输入框共用一个 id,
    // 自动化拿到的是文档序第一个,到底是哪一栏看运气(找茵第九轮)。
    expect(harness.container.querySelector('[data-testid="chat-composer-aside"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="chat-composer"]')).toBeNull()
    // 自造那份的 test id 一个都不许还在(留着就是它悄悄回来了)。
    expect(harness.container.querySelector('[data-testid="topic-split-input"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-split-send"]')).toBeNull()
  })

  it('分栏输入框的上下留白与主线那一份一致 —— ❌ 不许一个贴着窗底、一个悬在上面', async () => {
    // owner 2026-09-19 实测(两栏并排的截图):「这个高度怎么不一致」。
    // 两个输入框的胶囊本身都是 42px,差的是外面那一圈:主线有 `12px 22px 18px`,
    // 分栏这一份原先什么都没有 ⇒ 胶囊直接压在窗底,并排看就是两个高度。
    const chatArea = await readFile('apps/desktop/src/components/ChatAreaPanel.tsx', 'utf8')
    expect(chatArea, '主线 composer 的外边距变了 —— 分栏这一份要跟着改,否则两边又会漂开').toContain("'12px 22px 18px'")

    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps }))
    const wrapper = harness.container
      .querySelector('[data-testid="chat-composer-aside"]')
      ?.closest('[data-topic-split-composer]') as HTMLElement
    expect(wrapper, '分栏的输入框没有外层留白容器').toBeTruthy()
    // 垂直方向必须与主线逐字相同;水平方向故意窄一档(这一栏比主栏窄,照抄 22 会把胶囊挤细)。
    expect(wrapper.style.paddingTop).toBe('12px')
    expect(wrapper.style.paddingBottom).toBe('18px')
  })

  // 找茵第九轮 —— 「用的是同一个组件」不等于「那个组件被接全了」。
  // 分栏复用了 MessageList,却一个滚动 prop 都没传 ⇒ owner 报的「消息列表不会滚动」
  // 在**有历史的**话题上原样还在(新建的空话题看不出来:内容短于视口 ⇒ atBottom 恒真)。
  // 所以这一格不铉「传没传」,铉的是缺省行为本身。
  it('分栏的消息列表默认就停在最新一条,且内容一长高还贴着底就重新贴底', async () => {
    // jsdom 没有布局也没有 ResizeObserver:几何按副栏滚动容器给,ResizeObserver 换成可手动触发的替身。
    const geometry = { scrollHeight: 1000 }
    const tops = new WeakMap<Element, number>()
    const aside = (el: Element) => el instanceof HTMLElement && el.dataset.unreadStreamSurface === 'aside'
    Object.defineProperties(HTMLElement.prototype, {
      scrollHeight: { configurable: true, get(this: HTMLElement) { return aside(this) ? geometry.scrollHeight : 0 } },
      clientHeight: { configurable: true, get(this: HTMLElement) { return aside(this) ? 300 : 0 } },
      scrollTop: { configurable: true, get(this: HTMLElement) { return tops.get(this) ?? 0 }, set(this: HTMLElement, v: number) { tops.set(this, Math.min(Math.max(0, v), aside(this) ? geometry.scrollHeight - 300 : 0)) } },
    })
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class { constructor(private readonly cb: () => void) {} observe() { observers.push(this.cb) } disconnect() {} unobserve() {} })
    try {
      await renderWithAppProviders(harness, createNode(TopicSplitPane, {
        ...baseProps,
        messages: [message({ id: 'm1', content: '第一句' }), message({ id: 'm2', content: '最新一句' })],
      }))
      const scroller = harness.container.querySelector('[data-unread-stream-surface="aside"]') as HTMLElement
      expect(scroller, '副栏的滚动容器不在 DOM 里').toBeTruthy()
      expect(scroller.scrollTop, '打开就停在最新一条').toBe(700)

      geometry.scrollHeight = 1400
      await act(async () => { observers.forEach((cb) => cb()) })
      expect(scroller.scrollTop, '贴着底时内容长高 ⇒ 重新贴底').toBe(1100)

      // 阴控:往上翻开之后内容再长高,不拽回来。
      scroller.scrollTop = 300
      await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
      geometry.scrollHeight = 1600
      await act(async () => { observers.forEach((cb) => cb()) })
      expect(scroller.scrollTop).toBe(300)
    } finally {
      vi.unstubAllGlobals()
      for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    }
  })

  // owner 2026-09-19 第二轮:「没改到底的这几个应该改到底」。
  // 「不会滚动」那条我第一遍只补了「打开停在哪一句」和「新消息钳底」,**往上翻**那一半还是空的:
  // 分栏一次只拿最新一页,滚到顶什么都不来、也不报错。这一格盯的就是那一半。
  // ── 复用的那道结构闸 ────────────────────────────────────────────────────────
  // owner 为同一个形状纠正了两轮:我把组件换成了原件,却没把它的入参接全 ⇒ 用的是同一个组件,
  // 行为却少一半,而且不报错。第三次不该再靠人眼去对 —— 这一格把「两个调用点的入参差异」本身
  // 变成判据:主线传了而分栏没传的每一个 prop,要么接上,要么写进下面的名单并说清为什么不需要。
  // 名单之外出现新的差异 = 红。
  const JUSTIFIED_OMISSIONS: Record<string, Record<string, string>> = {
    MessageList: {
      unreadAbove: '#6530 从会话列表点开主线时记下的第一条未读(「↑ N 条新消息」);话题从列表打开是分栏,不走这条路,分栏没有这枚标签',
      topInset: '给 agent 单聊头栏里探出头栏的那只小鸟让位(滚到最上时第一条不被它的脚压住);分栏没有 agent 头栏,也就没有探出的部分',
      footer: '#7199 只有「助理」App 那个聊天面在消息流末尾接一个「它在处理」的打字气泡(取代运行条);分栏不传 = 运行条照旧,与对话页同形',
    },
    InputArea: {
      beforeSend: 'agent 私聊专用(任务页会话恢复前置),话题是场所型会话',
      disabled: 'agent 私聊专用(引擎不可用时禁用输入)',
      disabledReason: '同上',
      whisperTarget: '悄悄话入口在成员卡片上,且它落到主线输入框;话题里能不能悄悄话 spec 没说',
      onExitWhisper: '同上',
      attachGlyph: '#7199 只有「助理」App 那个聊天面把附件钮换成「+」;分栏不传 = 组件缺省的回形针,与对话页同形',
      attachMenu: '#7199 「+」里的「录制语音笔记」只在「助理」App 那个聊天面(录下的交给个人助理);分栏不传 = 点了直接选文件,与对话页同形',
    },
  }
  function jsxProps(source: string, tag: string): string[] {
    // ⚠️ 不能用 indexOf(`<${tag}`):`useMemo<MessageListRowProps>` 这种泛型会先命中。
    // 要的是真的那个 JSX 开标签 —— 名字后面跟空白 / `/` / `>`。
    const open = source.search(new RegExp(`<${tag}(?=[\\s/>])`))
    if (open < 0) return []
    // ⚠️ 注释要在**找结尾之前**抹掉:主线那段注释里写着 `scrollHeight-clientHeight > 80`,
    // 那个 `>` 在深度 0 上 —— 先扫结尾的话开标签会在注释中间被截断,后面的 prop 全部看不见,
    // 于是这道闸对它们永远是绿的。
    const scan = source.slice(open).replace(/\/\/[^\n]*/g, '')
    let depth = 0
    let end = 0
    while (end < scan.length) {
      const ch = scan[end]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      else if (ch === '>' && depth === 0) break
      end += 1
    }
    const block = scan.slice(tag.length + 1, end)
    // 只收**深度 0** 上的 `name=` —— 即真的属性名。❌ 不能只认行首:主线那边有一行写了三个 prop
    // (`groupMembers={…} currentUserId={…} agentStatuses={…}`),按行首扫会把后两个当不存在,
    // 于是这道闸对它们永远是绿的 —— 一道判不出差别的闸比没有闸更糟。
    const names: string[] = []
    let level = 0
    for (let k = 0; k < block.length; k += 1) {
      const ch = block[k]
      if (ch === '{') { level += 1; continue }
      if (ch === '}') { level -= 1; continue }
      if (level !== 0) continue
      const rest = block.slice(k)
      // `name={…}`、`name="…"` 与**裸布尔** `isGroupChat` 三种写法都要认出来 ——
      // 分栏那边写的正是裸的那种,只认带等号的会把它误报成「没传」。
      const hit = /^([a-z][A-Za-z0-9]*)\s*(?:=|(?=\s|\/|$))/.exec(rest)
      if (hit && (k === 0 || /[\s]/.test(block[k - 1]!))) {
        names.push(hit[1]!)
        k += hit[0].length - 1
      }
    }
    return names
  }
  // gugu-dev#181 第 ⑤ 步:块里的话题是页签条上和群对话并排的一枚页签,这一栏不再画自己那条头;不给 tabHost(对话页)头照旧。
  it('在块里:话题画成页签条上的一枚页签(× = 收起分栏),这一栏没有自己的头', async () => {
    const tabs = document.body.appendChild(document.createElement('span'))
    const onClose = vi.fn()
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, onClose, tabHost: tabs }))
    expect(harness.container.querySelector('[data-testid="topic-split-close"]'), 'the block tab strip is the header').toBeNull()
    const tab = tabs.querySelector('[data-topic-tab="topic-1"]')
    expect(tab?.textContent).toContain('分片下载失败')
    await act(async () => { tab!.querySelector<HTMLElement>('button[aria-label]')!.click() })
    expect(onClose).toHaveBeenCalledOnce()
    tabs.remove()
  })

  it('不在块里(对话页):这一栏照旧有自己的头,也不画页签', async () => {
    await renderWithAppProviders(harness, createNode(TopicSplitPane, baseProps))
    expect(harness.container.querySelector('[data-testid="topic-split-close"]')).not.toBeNull()
    expect(document.querySelector('[data-topic-tab]')).toBeNull()
  })

  it('分栏与主线的入参差异只能是名单上那几条 —— 复用组件不等于接全它的契约', async () => {
    const panel = await readFile('apps/desktop/src/components/ChatAreaPanel.tsx', 'utf8')
    const pane = await readFile('apps/desktop/src/components/chat/TopicSplitPane.tsx', 'utf8')
    for (const tag of ['MessageList', 'InputArea']) {
      const main = new Set(jsxProps(panel, tag))
      const aside = new Set(jsxProps(pane, tag))
      expect(main.size, `${tag}: 主线那个调用点没解析出任何 prop,这一格就判不了事`).toBeGreaterThan(3)
      const missing = [...main].filter((name) => !aside.has(name) && !(name in JUSTIFIED_OMISSIONS[tag]!))
      expect(missing, `${tag}: 主线传了而分栏没传,且名单上没写为什么 —— 接上它,或写进 JUSTIFIED_OMISSIONS`).toEqual([])
      // 反向:名单不许留过期条目(已经接上了还挂在名单里,下次就挡不住真的漏)。
      const stale = Object.keys(JUSTIFIED_OMISSIONS[tag]!).filter((name) => aside.has(name))
      expect(stale, `${tag}: 这些已经接上了,把它们从 JUSTIFIED_OMISSIONS 里删掉`).toEqual([])
    }
  })

  // 接完一页视口钉在原处:列表在头部插行的那次提交里把读者正看着的那一行放回原处(几何用例见 flowList.test.tsx)。
  it('分栏滚到顶附近就去要下一页', async () => {
    const onRevealOlder = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...baseProps,
      messages: [message({ id: 'm1', seq: 2, content: '第一句' })],
      history: { ...baseProps.history, revealOlder: onRevealOlder },
    }))
    const scroller = harness.container.querySelector('[data-unread-stream-surface="aside"]') as HTMLElement
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 }, scrollTop: { configurable: true, value: 0, writable: true } })
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(onRevealOlder).toHaveBeenCalledTimes(1)
  })

  it('分栏的 @ 候选看得见 agent 在不在线', async () => {
    // 话题里 @ 就是「把人拉进来」的动作,看不见状态就是盲拉。
    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...baseProps,
      mentionMembers: [{ id: 'agent-9', name: '小柯', type: 'agent' as const }],
      agentStatuses: { 'agent-9': { online: false, label: '离线' } },
    }))
    const source = await readFile('apps/desktop/src/components/chat/TopicSplitPane.tsx', 'utf8')
    expect(source).toContain('agentStatuses={agentStatuses}')
  })

  it('window 级的附件入队事件 ❌ 不进副栏的输入框', async () => {
    // 与焦点登记同一个形状:一个 window 事件,两个输入框都听 ⇒ 一次 attach 同时进两个队列。
    const onSendAttachments = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, onSendAttachments }))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('__chat_composer_attach_files', {
        detail: { files: [new File(['x'], '不该进来.png', { type: 'image/png' })] },
      }))
    })
    expect(harness.container.querySelector('[data-testid="pending-attachment-preview"]')).toBeNull()
  })

  it('分栏的回形针发得出去 —— ❌ 不允许「挂得上、发不出、一声不响」', async () => {
    const onSendAttachments = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, onSendAttachments }))
    const composer = harness.container.querySelector('[data-testid="chat-composer-aside"]') as HTMLTextAreaElement
    expect(composer).not.toBeNull()
    // 走真人那条路:回形针 → 文件选择器 → change。❌ 不走 window 事件那个自动化口 ——
    // 那一口现在只归主输入框(见下一格),拿它来驱动副栏等于测了个不存在的路径。
    const picker = harness.container.querySelector('input[type="file"]') as HTMLInputElement
    expect(picker, '分栏的输入框没有文件选择器').toBeTruthy()
    Object.defineProperty(picker, 'files', {
      value: [new File(['x'], '现场图.png', { type: 'image/png' })], configurable: true,
    })
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
    const send = harness.container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement
      ?? harness.container.querySelector('button[aria-label="发送"]') as HTMLButtonElement
    expect(send, '找不到发送键').toBeTruthy()
    await clickElement(send)
    expect(onSendAttachments).toHaveBeenCalledTimes(1)
  })

  it('分栏的输入框 ❌ 不抢全局「聚焦输入框」的落点', async () => {
    // registerComposerFocusTarget 是模块级单例,后挂载的那个赢。分栏一登记,
    // 主线发完一条后的 scheduleComposerFocus('message-sent') 就把光标送进话题输入框 ⇒
    // 用户接着打的下一句回车发进了话题。正是话题要隔离的那个方向,反过来了。
    const { focusComposer, registerComposerFocusTarget } = await import('../../../apps/desktop/src/lib/focusComposer')
    const main = document.createElement('textarea')
    document.body.appendChild(main)
    const release = registerComposerFocusTarget(() => main)
    try {
      await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps }))
      const aside = harness.container.querySelector('[data-testid="chat-composer-aside"]') as HTMLTextAreaElement
      expect(aside).not.toBeNull()
      expect(focusComposer('message-sent')).toBe(true)
      expect(document.activeElement, '光标被分栏抢走了').toBe(main)
    } finally {
      release()
      main.remove()
    }
  })

  it('在分栏里发出去的东西落在话题里,引用走结构化 replyToMessageId', async () => {
    // 老毛病:分栏把主线的 handleQuote 直接透过来,于是在话题里点「引用」,引用条出现在
    // **左边来源线**的输入框上 —— 发出去就发在源群里,正是话题要隔离掉的那个方向。
    const source = await readFile('apps/desktop/src/components/chat/TopicSplitPane.tsx', 'utf8')
    expect(source).not.toMatch(/^\s*onQuote\?: /m)
    // 引用发出去走**结构化** replyToMessageId,❌ 不是把 `> 引文` 拼进正文 ——
    // 只有结构化那条路才有引用条、点得回原消息,group-routing 的「回复穿透档位」也才叫得醒被引用的 agent。
    expect(source).toContain("opts?.replyToMessageId ?? null")
    // 引用条认主体:换话题时 ❌ 不许漂过去(这个组件实例在换话题时不重挂)。
    expect(source).toContain("const activeQuote = quoted?.forChatId === topic.chatId ? quoted : null")

    expect(quotePrefixOf({ content: '分片那段我看了,是 range 请求被网关吃了' }))
      .toBe('> 分片那段我看了,是 range 请求被网关吃了')
    expect(quotePrefixOf({ content: 'x'.repeat(200) })).toBe(`> ${'x'.repeat(60)}…`)
    expect(quotePrefixOf({ content: '第一行\n第二行' })).toBe('> 第一行')
  })

  it('收起分栏的文案与话题状态分开;❌ 没有「全宽打开」键,想看大一点拖分割线', async () => {
    const onClose = vi.fn()
    await harness.render(createNode(TopicSplitPane, { ...baseProps, onClose }))
    const pane = harness.container.querySelector('[data-testid="topic-split-pane"]')
    expect(pane).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-split-messages"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-breadcrumb-name"]')?.textContent).toBe('分片下载失败')

    const close = harness.container.querySelector('[data-testid="topic-split-close"]') as HTMLElement
    expect(close.getAttribute('aria-label')).toBe('收起分栏')
    expect(close.getAttribute('title')).toBe('收起分栏，话题不会关闭')
    // 「没有开关,只有沉降」:界面上 ❌ 不许出现关闭/完成话题。
    expect(harness.container.textContent).not.toContain('关闭话题')
    expect(harness.container.textContent).not.toContain('完成话题')

    await clickElement(close)
    expect(onClose).toHaveBeenCalledTimes(1)

    // @@@5856 owner 2026-09-19:「不应该有这个按钮,你只要保证分割线可分割就行了」。
    // 这两条断言成对:没有那颗键 **且** 真有一条能拖的分割线 ——
    // 只断言前一条的话,把宽度焊死也能过,而那时「想看大一点」就没有任何出口了。
    expect(harness.container.querySelector('[data-testid="topic-split-open-full"]')).toBeNull()
    const handle = harness.container.querySelector('[data-testid="topic-split-resize-handle"]')
    expect(handle).not.toBeNull()
    expect(handle?.getAttribute('role')).toBe('separator')
    expect(handle?.getAttribute('aria-label')).toBe('拖动改变话题分栏的宽度')
  })

  it('手机上放不下两栏:话题整页盖住来源线,出口只有左上返回,子视图开着先退回话题', async () => {
    const onClose = vi.fn()
    // currentUserId 置空:附件子视图不去拉文件,这一格只判导航。
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, onClose, currentUserId: null, mobile: true }))
    // 与上一格(桌面)同一份 props:手机上 ❌ 分割线、❌ 收起键,❌ 挤进一条与来源线并排的栏。
    expect(harness.container.querySelector('[data-testid="topic-split-resizable"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-split-resize-handle"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-split-close"]')).toBeNull()
    const page = harness.container.querySelector('[data-testid="topic-split-pane"]')?.parentElement as HTMLElement
    expect(page.style.position).toBe('fixed')
    const back = () => harness.container.querySelector('[data-testid="topic-split-back"]') as HTMLElement
    expect(back().getAttribute('aria-label')).toBe('返回')

    // 手机页头右边只有成员 + ⋯(与群聊页 compactRoom 一致):附件在 ⋯ 里。
    expect(harness.container.querySelector('[data-testid="topic-split-files-toggle"]')).toBeNull()
    await clickElement(harness.container.querySelector('[data-testid="topic-split-more"]') as HTMLElement)
    await clickElement(document.querySelector('[data-testid="topic-split-files-toggle"]') as HTMLElement)
    expect(harness.container.querySelector('[data-testid="history-panel"]')).not.toBeNull()
    await clickElement(back())
    expect(onClose, '附件开着时返回就离开了话题').not.toHaveBeenCalled()
    expect(harness.container.querySelector('[data-testid="history-panel"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="topic-split-messages"]')).not.toBeNull()

    await clickElement(back())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // 170 10-19:页头 ⋯ 打开本机的 App(#7469)只在群和私聊的页头,话题的分栏与手机整页一直没有 —— 话题里要开 App 只能靠卡片。
  // 现在话题用同一份菜单项(OpenAppMenuItems):点一下 = openApp(它, 这个话题)。手机的 ⋯ 里先是附件、文件夹,再是 App。
  for (const mobile of [false, true]) {
    it(`${mobile ? '手机整页' : '桌面分栏'}:话题页头 ⋯ 列出本机能开的 App,点一下在这个话题的右栏打开`, async () => {
      runInAction(() => {
        installedExtensionsStore.manifests = [parseExtensionManifest({ id: 'turtle-soup', name: '海龟汤', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: '海龟汤' }] } })]
      })
      const asked = vi.fn()
      const listen = (event: Event) => asked((event as CustomEvent).detail)
      window.addEventListener(UI_EVENTS.openApp, listen)
      try {
        await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, currentUserId: null, mobile }))
        await clickElement(harness.container.querySelector('[data-testid="topic-split-more"]') as HTMLElement)
        const rows = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].map((row) => row.querySelector('.gg-menu-item-label')?.textContent)
        expect(rows).toEqual(mobile ? ['附件', '文件夹', '海龟汤'] : ['海龟汤'])
        await clickElement(document.querySelector('[data-testid="chat-header-menu-app"]') as HTMLElement)
        expect(asked).toHaveBeenCalledWith({ extensionId: 'turtle-soup', chatId: 'topic-1' })
      } finally {
        window.removeEventListener(UI_EVENTS.openApp, listen)
        runInAction(() => { installedExtensionsStore.manifests = [] })
      }
    })
  }

  it('桌面分栏:本机没有能开的 App 就没有 ⋯', async () => {
    await renderWithAppProviders(harness, createNode(TopicSplitPane, { ...baseProps, currentUserId: null }))
    expect(harness.container.querySelector('[data-testid="topic-split-more"]')).toBeNull()
  })

  it('消息走 MessageRow + MessageBubble 渲染（接住 MessageBubble 的 props 漂移）', async () => {
    await renderWithAppProviders(
      harness,
      createNode(TopicSplitPane, {
        ...baseProps,
        messages: [message({ id: 'm1', chat_id: 'topic-1', content: '我先看分片那段' })],
      }),
    )
    const list = harness.container.querySelector('[data-testid="topic-split-messages"]') as HTMLElement
    expect(list.querySelectorAll('[role="listitem"]').length).toBe(1)
    expect(list.querySelector('[data-msg-id="m1"]')).not.toBeNull()
    expect(list.textContent).toContain('我先看分片那段')
    expect(harness.container.querySelector('[data-testid="topic-split-empty"]')).toBeNull()
  })

  // @@@5856 '自带的输入框回车发送，发送期间禁用' 已删 —— 分栏不再自带输入框,
  // 回车发送/发送期间禁用/失败提示全部归 InputArea 自己的判据(它本来就有)。
  // ❌ 不在这里再抄一份:抄一份等于允许两份实现漂开,而那正是这次被 owner 点破的毛病。
})

describe('@@@5856 「这条消息开得出话题吗」只有一个判据,顶栏与右键共用', () => {
  const base = { id: 'm', seq: 1, local_send_state: undefined, is_whisper: false, retracted_at: null, content_type: 'text' } as Parameters<typeof canSourceTopic>[0]
  it('发送中 / 未送达 / 悄悄话 / 已撤回 都开不出;正常消息开得出', () => {
    expect(canSourceTopic(base)).toBe(true)
    expect(canSourceTopic({ ...base, seq: -1 })).toBe(false)
    expect(canSourceTopic({ ...base, local_send_state: 'sending' })).toBe(false)
    expect(canSourceTopic({ ...base, local_send_state: 'failed' })).toBe(false)
    expect(canSourceTopic({ ...base, is_whisper: true })).toBe(false)
    expect(canSourceTopic({ ...base, retracted_at: new Date().toISOString() })).toBe(false)
    // 系统消息与附件服务端是收的(名字回落成「话题」)⇒ 客户端也收,❌ 不许比服务端严。
    expect(canSourceTopic({ ...base, content_type: 'system' })).toBe(true)
    expect(canSourceTopic({ ...base, content_type: 'attachment' })).toBe(true)
  })

  it('右键菜单与顶栏按钮走的是同一个函数,❌ 不各写一份', async () => {
    // 找茬第八轮:右键那边只挡了悄悄话和撤回,于是在发失败的红气泡上还能点「开话题」,
    // 点完服务端必拒(is not a live message),界面只给一句帮不上忙的 toast。
    const bubble = await readFile('apps/desktop/src/components/chat/MessageBubble.tsx', 'utf8')
    expect(bubble).toContain("import { canSourceTopic } from './topicSplitModels'")
    // 悬停条 ⋯、右键菜单、手机长按面板三处的动作都出自同一个 messageActions ⇒ 判据只写一次,三处都从它拿。
    expect(bubble.match(/onOpenTopic && canSourceTopic\(msg\)/g)).toHaveLength(1)
    expect(bubble.match(/\{\.\.\.messageActions\(/g)).toHaveLength(3)
    expect(bubble).not.toContain('onOpenTopic && !msg.is_whisper')
  })
})

describe('顶栏那颗「开话题」挑来源:只挑服务端会收的那一条', () => {
  type Row = Parameters<typeof latestTopicSourceIdOf>[0][number]
  function row(overrides: Partial<Row> & { id: string }): Row {
    return { seq: 1, local_send_state: undefined, is_whisper: false, retracted_at: null, content_type: 'text', ...overrides } as Row
  }

  it('正control:一条正常的文本消息就是来源,取的是最新那条', () => {
    expect(latestTopicSourceIdOf([row({ id: 'old', seq: 1 }), row({ id: 'new', seq: 2 })])).toBe('new')
  })

  it('末尾挂着发失败的红气泡时,往前退到上一条真消息 —— ❌ 不是「这条线开不出话题」', () => {
    const rows = [row({ id: 'real', seq: 3 }), row({ id: 'optimistic', seq: -1, local_send_state: 'failed' })]
    expect(latestTopicSourceIdOf(rows)).toBe('real')
  })

  it('悄悄话与撤回跳过 —— 与服务端那两条硬拒对齐', () => {
    const rows = [
      row({ id: 'real', seq: 1 }),
      row({ id: 'whisper', seq: 2, is_whisper: true }),
      row({ id: 'retracted', seq: 3, retracted_at: '2026-09-19T00:00:00.000Z' }),
    ]
    expect(latestTopicSourceIdOf(rows)).toBe('real')
  })

  it('系统消息与附件**收**,因为服务端收 —— ❌ 客户端不许比服务端严', () => {
    // 比服务端严的后果:一条最近全是附件的线(或刚建好只有入群系统消息的新群)上,
    // 这颗按钮整颗消失且不给任何解释。服务端对这两种是接受的,只是名字回落成「话题」。
    expect(latestTopicSourceIdOf([row({ id: 'attachment', content_type: 'attachment' })])).toBe('attachment')
    expect(latestTopicSourceIdOf([row({ id: 'system', content_type: 'system' })])).toBe('system')
  })

  it('一条都挑不出来时返回 null,按钮就不画 —— ❌ 不是指到一条必被拒的消息上', () => {
    expect(latestTopicSourceIdOf([row({ id: 'whisper', is_whisper: true })])).toBeNull()
    expect(latestTopicSourceIdOf([])).toBeNull()
  })
})

describe('历史面板的默认落点', () => {
  it('群落在话题、私聊落在导入历史、话题自己落在附件', () => {
    expect(defaultHistoryTab('group')).toBe('topics')
    expect(defaultHistoryTab('private')).toBe('imported')
    expect(defaultHistoryTab('topic')).toBe('attachments')
  })

  it('❌ 私聊不许因为多了话题 tab 就改落点 —— 这条断言就是为那次回归立的', () => {
    expect(defaultHistoryTab('private')).not.toBe('topics')
  })
})

describe('一条会话在界面上叫什么(会话列表 / 转发目标 / 话题面包屑读同一份)', () => {
  it('场所用自己的名字,dm/ai 用对端', () => {
    expect(chatDisplayName({ kind: 'topic', name: '分片下载失败', peer_alias: null }, undefined)).toBe('分片下载失败')
    expect(chatDisplayName({ kind: 'group', name: '发版群', peer_alias: null }, undefined)).toBe('发版群')
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, '小明')).toBe('小明')
  })

  it('备注压过对端本名', () => {
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: '  老王  ' }, '王某某')).toBe('老王')
  })

  it('场所名为空时用兜底名 —— 空串会让这一行在列表里消失、在转发框里搜不到', () => {
    expect(chatDisplayName({ kind: 'topic', name: '', peer_alias: null }, undefined)).toBe('话题')
    expect(chatDisplayName({ kind: 'topic', name: '   ', peer_alias: null }, undefined)).toBe('话题')
  })

  it('❌ dm/ai 的对端解析不出来时必须是空串,不许拿兜底名冒充(#1623 / #1624)', () => {
    // 假名字会把「对端解析失败」这个 bug 藏起来:#1623 就是一条 agent 私聊安静地画成「聊天」。
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, undefined)).toBe('')
    expect(chatDisplayName({ kind: 'ai', name: '', peer_alias: null }, undefined)).toBe('')
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, '  ')).toBe('')
  })
})

describe('话题里能点名谁', () => {
  const identities = {
    'u-in': { display_name: '话题里的人', type: 'human' as const },
    'u-src': { display_name: '来源线的人', type: 'human' as const },
    'a-src': { display_name: 'Agent 甲', type: 'agent' as const },
    'u-noname': { display_name: '  ', type: 'human' as const },
  }
  const own = [{ id: 'u-in', name: '话题里的人', type: 'human' as const }]

  it('来源线的成员并进候选 —— 与服务端 is_addressable_in 对齐', () => {
    const got = withSourceLineCandidates(own, ['u-in', 'u-src', 'a-src'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-in', 'u-src', 'a-src'])
  })

  it('已经在话题里的人不重复,身份解析不出名字的不进集合(名字是投递依据)', () => {
    const got = withSourceLineCandidates(own, ['u-in', 'u-noname', 'unknown-id'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-in'])
  })

  it('没有来源线(群/私聊)时原样返回,❌ 不凭空多出候选', () => {
    expect(withSourceLineCandidates(own, undefined, identities)).toBe(own)
    expect(withSourceLineCandidates(own, [], identities)).toBe(own)
  })
})

describe('useTopicsOfChat', () => {
  let observed: { topics: TopicSummary[]; loading: boolean; error: string | null; byMessage: Map<string, TopicSummary[]> }
  let reload: () => void

  function Probe({ sourceChatId }: { sourceChatId: string | null }) {
    const state = useTopicsOfChat(sourceChatId)
    reload = state.reload
    useEffect(() => {
      observed = { topics: state.topics, loading: state.loading, error: state.error, byMessage: state.bySourceMessageId }
    })
    return null
  }

  it('切会话时旧响应 ❌ 不许覆盖新会话的状态', async () => {
    const slowA = deferred<TopicSummary[]>()
    const fastB = deferred<TopicSummary[]>()
    listTopicsOfChat.mockImplementation((chatId) => (chatId === 'chat-A' ? slowA.promise : fastB.promise))

    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    expect(listTopicsOfChat).toHaveBeenCalledWith('chat-A')

    // 还没等 A 回来就切到 B。
    await harness.render(createElement(Probe, { sourceChatId: 'chat-B' }))
    expect(listTopicsOfChat).toHaveBeenCalledWith('chat-B')
    // 切线即清空:上一条线的话题不许在新线的首帧里留一拍。
    expect(observed.topics).toEqual([])

    await act(async () => {
      fastB.resolve([topic({ chat_id: 'topic-b', source_message_id: 'msg-b' })])
      await Promise.resolve()
    })
    expect(observed.topics.map((row) => row.chat_id)).toEqual(['topic-b'])

    // A 的慢响应现在才到 —— 没有守卫的话它会把 B 的状态盖掉。
    await act(async () => {
      slowA.resolve([topic({ chat_id: 'topic-a', source_message_id: 'msg-a' })])
      await Promise.resolve()
    })
    expect(observed.topics.map((row) => row.chat_id)).toEqual(['topic-b'])
    expect(observed.loading).toBe(false)
    expect([...observed.byMessage.keys()]).toEqual(['msg-b'])
  })

  it('sourceChatId 为 null 时不请求（话题上不再开话题，单层不嵌套）', async () => {
    await harness.render(createElement(Probe, { sourceChatId: null }))
    expect(listTopicsOfChat).not.toHaveBeenCalled()
    expect(observed.topics).toEqual([])
    expect(observed.loading).toBe(false)
    // 单层不嵌套的守卫在调用点:话题会话本身 → null。
    expect(topicsSourceChatId({ id: 'topic-1', kind: 'topic' })).toBeNull()
    expect(topicsSourceChatId({ id: 'group-1', kind: 'group' })).toBe('group-1')
    expect(topicsSourceChatId(null)).toBeNull()
  })

  it('bySourceMessageId 把同一条来源消息的多条话题归一组；reload 重新取', async () => {
    listTopicsOfChat.mockResolvedValue([
      topic({ chat_id: 'topic-a', source_message_id: 'msg-1' }),
      topic({ chat_id: 'topic-b', source_message_id: 'msg-1' }),
      topic({ chat_id: 'topic-c', source_message_id: 'msg-2' }),
    ])
    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    await act(async () => { await Promise.resolve() })
    expect(observed.byMessage.get('msg-1')?.map((row) => row.chat_id)).toEqual(['topic-a', 'topic-b'])
    expect(observed.byMessage.get('msg-2')?.map((row) => row.chat_id)).toEqual(['topic-c'])

    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await act(async () => { reload(); await Promise.resolve() })
    expect(listTopicsOfChat).toHaveBeenCalledTimes(2)
  })

  it('列不出来就说列不出来，❌ 不静默当成「这条线上没有话题」', async () => {
    listTopicsOfChat.mockRejectedValue(new Error('permission denied for function list_topics_of_chat'))
    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    await act(async () => { await Promise.resolve() })
    expect(observed.error).toContain('permission denied')
    expect(observed.loading).toBe(false)
  })
})

// @@@5856 会话列表里「话题挂在来源线底下」的两条规则 + 「开成分栏」那条请求的收发。
//
// owner 2026-09-19:「怎么还有把一个 topic 当做群的形式表达,我前面提的 7 个问题,不是让你改了吗」
// 这一组钉的是**我上一版真的做错了的三件事**:
//   ① 话题占了一行平级的会话(他截图框的就是这个)。
//   ② 点子行毫无反应 —— 请求在聊天区挂载之前发出去,没人接,丢了。
//   ③ 分栏是 subject-scoped 的:点下去那一刻主区显示的还是上一条线,当场开分栏会记到旧线名下,
//      切过去之后立刻不显示,看起来还是「点了没反应」。
describe('会话列表:话题是来源线的子行,不是一行平级的会话', () => {
  type Row = {
    id: string; kind: string; name: string
    source_chat_id?: string | null; last_message_at?: string
    is_pinned?: boolean; is_marked_unread?: boolean; unread_count?: number
  }
  const chat = (id: string, over: Partial<Row> = {}): Row =>
    ({ id, kind: 'group', name: id, last_message_at: '2026-09-19T00:00:00Z', unread_count: 0, ...over })
  const topicRow = (id: string, source: string, over: Partial<Row> = {}): Row =>
    chat(id, { kind: 'topic', source_chat_id: source, ...over })
  const byTime = (a: Row, b: Row) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
  const all = () => true
  const allListed = () => true
  const nest = async () => import('../../../apps/desktop/src/components/chatListTopicNesting')

  it('话题按来源线归组，并且永远不占一行顶层', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const rows = [chat('g1'), topicRow('t1', 'g1'), chat('g2'), topicRow('t2', 'g1'), topicRow('t3', 'g2')]
    const nesting = groupTopicsBySource(rows as never, all, byTime as never, allListed)
    expect(nesting.bySource.get('g1')?.map((r) => r.id)).toEqual(['t1', 't2'])
    expect(nesting.bySource.get('g2')?.map((r) => r.id)).toEqual(['t3'])
    for (const row of rows) {
      expect(isTopLevelChatRow(row as never, nesting, all, all)).toBe(row.kind !== 'topic')
    }
  })

  it('溯源指针缺失的话题不归到任何一条线下（❌ 也不因此凭空消失）', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const orphan = topicRow('t-orphan', 'g1', { source_chat_id: null })
    const nesting = groupTopicsBySource([chat('g1'), orphan] as never, all, byTime as never, allListed)
    expect(nesting.bySource.size).toBe(0)
    // 挂不上去 ⇒ 退回顶层。人还在这条话题里、它照样给人发通知,❌ 不许从列表上蒸发。
    expect(isTopLevelChatRow(orphan as never, nesting, all, all)).toBe(true)
  })

  // @@@5856 找茬第十轮的阻断:群主把来源群解散/归档之后,我仍是话题成员、话题仍 active、
  // 消息照样通知我,但子行没地方挂 ⇒ 两条话题一起从列表上消失,连搜都搜不到。
  it('来源线被归档/已退出:它底下的话题退回顶层，❌ 不许跟着一起消失', async () => {
    const { groupTopicsBySource, isTopLevelChatRow, splitSunkTopics } = await nest()
    const archived = chat('发版群')
    const t1 = topicRow('分片下载', '发版群')
    const listed = (row: { id: string }) => row.id !== '发版群'
    const nesting = groupTopicsBySource(
      [archived, t1] as never, (row) => listed(row), byTime as never,
      (sourceId) => listed({ id: sourceId }),
    )
    expect(nesting.bySource.size).toBe(0)
    expect(isTopLevelChatRow(t1 as never, nesting, listed as never, all)).toBe(true)
    // 反例:来源线还在时它就该老老实实当子行,❌ 不许两头都出现。
    const healthy = groupTopicsBySource([archived, t1] as never, all, byTime as never, allListed)
    expect(isTopLevelChatRow(t1 as never, healthy, all, all)).toBe(false)
    expect(splitSunkTopics(healthy.bySource.get('发版群') ?? [], () => false).live.map((r) => r.id))
      .toEqual(['分片下载'])
  })

  it('搜到的是话题、来源线一个字都不匹配时，来源线照样占一行 —— 否则那条话题无处可挂', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const source = chat('发版群')
    const hit = topicRow('分片下载', '发版群')
    const miss = chat('别的群')
    const matchesSearch = (row: { id: string }) => row.id === '分片下载'
    const nesting = groupTopicsBySource(
      [source, hit, miss] as never, matchesSearch as never, byTime as never, allListed)
    expect(nesting.bySource.get('发版群')?.map((r) => r.id)).toEqual(['分片下载'])
    // 正例与反例都要:命中了才留,没命中也没有子行的照样被搜索筛掉。
    expect(isTopLevelChatRow(source as never, nesting, all, matchesSearch as never)).toBe(true)
    expect(isTopLevelChatRow(miss as never, nesting, all, matchesSearch as never)).toBe(false)
  })

  // @@@5856 找茬第十轮的阻断:isSunkTopic 只对 kind==='topic' 为真,而话题永不占顶层 ⇒
  // 列表底部那个「更早」分段恒空,沉降在产品里整个死掉了(spec:「没有开关,只有沉降」)。
  // 沉降必须发生在**子行**这一层。
  it('沉降发生在子行这一层：静了太久的收进「更早」，活着的照常显示', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const live = topicRow('活的', 'g1', { last_message_at: '2026-09-19T00:00:00Z' })
    const old = topicRow('沉了的', 'g1', { last_message_at: '2026-08-01T00:00:00Z' })
    const nesting = groupTopicsBySource([chat('g1'), live, old] as never, all, byTime as never, allListed)
    const isSunk = (row: { id: string }) => row.id === '沉了的'
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], isSunk as never)
    expect(split.live.map((r) => r.id)).toEqual(['活的'])
    expect(split.sunk.map((r) => r.id)).toEqual(['沉了的'])
    // 反例:一条都没沉时不许凭空冒出「更早」那一行。
    expect(splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false).sunk).toEqual([])
  })

  // owner 2026-09-20 实测后将每条来源线的上限收至 3 条。
  it('子行最多摊开 3 条,多出来的并进同一个「更多」——❌ 不是消失,也❌ 不另加一个折叠控件', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    // 从新到旧 8 条;byTime 把它们排成 t8…t1。
    const rows = Array.from({ length: 8 }, (_, index) => topicRow(
      `t${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z` },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false)
    expect(split.live).toHaveLength(3)
    expect(split.live.map((r) => r.id)).toEqual(['t8', 't7', 't6'])
    // 多出来的五条进「更多」,一条都不许丢。
    expect(split.sunk.map((r) => r.id)).toEqual(['t5', 't4', 't3', 't2', 't1'])
    // 阳控:刚好 3 条时不显示「更多」。
    const few = groupTopicsBySource([chat('g2'), ...rows.slice(0, 3).map((r) => ({ ...r, source_chat_id: 'g2' }))] as never, all, byTime as never, allListed)
    expect(splitSunkTopics(few.bySource.get('g2') ?? [], () => false).sunk).toEqual([])
  })

  it('条数与时间两道并存:先按时间沉,再按条数收,「更早」里时间序不乱', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const rows = Array.from({ length: 7 }, (_, index) => topicRow(
      `u${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z` },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    // u1 静太久 ⇒ 时间沉;剩下六条里只摊开三条,溢出的三条排在时间沉的前面(它们更新)。
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], ((row: { id: string }) => row.id === 'u1') as never)
    expect(split.live.map((r) => r.id)).toEqual(['u7', 'u6', 'u5'])
    expect(split.sunk.map((r) => r.id)).toEqual(['u4', 'u3', 'u2', 'u1'])
  })

  // 角标数的是未读;有未读的话题若被条数上限并进「更多」,角标就清不掉(owner 10-19 现场:总群第 5 条话题 3 条未读)。
  it('有未读的话题不受 3 条上限，读完就回到上限之内', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const rows = Array.from({ length: 5 }, (_, index) => topicRow(
      `v${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z`, unread_count: index === 0 ? 3 : 0 },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false)
    expect(split.live.map((r) => r.id)).toEqual(['v5', 'v4', 'v3', 'v1'])
    expect(split.sunk.map((r) => r.id)).toEqual(['v2'])
    // 阴控:同一条读完(unread_count 0)就照常按条数收进「更多」。
    const read = rows.map((r) => ({ ...r, unread_count: 0 }))
    const after = splitSunkTopics(groupTopicsBySource([chat('g1'), ...read] as never, all, byTime as never, allListed).bySource.get('g1') ?? [], () => false)
    expect(after.live.map((r) => r.id)).toEqual(['v5', 'v4', 'v3'])
    expect(after.sunk.map((r) => r.id)).toEqual(['v2', 'v1'])
  })

  it('200 条话题侧栏仅 3 条,历史面板分批渲染且全部可达', async () => {
    const { splitSunkTopics } = await nest()
    const rows = Array.from({ length: 200 }, (_, index) => topicRow(`p${index}`, 'g1'))
    expect(splitSunkTopics(rows as never, () => false).live).toHaveLength(3)
    expect(pageHistoryTopics(rows, 1).shown).toHaveLength(HISTORY_TOPIC_PAGE)
    expect(pageHistoryTopics(rows, 2).shown).toHaveLength(HISTORY_TOPIC_PAGE * 2)
    expect(pageHistoryTopics(rows, 7)).toEqual({ shown: rows, remaining: 0 })
    expect(pageHistoryTopics(rows.slice(0, 3), 1)).toEqual({ shown: rows.slice(0, 3), remaining: 0 })
  })

})

describe('「把这条话题开成分栏」的请求:只有正显示来源线的那一帧才取得走', () => {
  it('来源线还没切过去时留在盒子里，切过去之后才取得到，且只取一次', async () => {
    const { requestTopicSplit, drainTopicSplitRequest } =
      await import('../../../apps/desktop/src/lib/topicSplitRequest')
    requestTopicSplit({ chatId: 't1', name: '北京天气', sourceChatId: 'g1' })
    // 点下去那一刻主区显示的还是上一条线 ⇒ 不许取走(取走就会把分栏记到旧线名下,切过去立刻消失)。
    expect(drainTopicSplitRequest('g0')).toBeNull()
    expect(drainTopicSplitRequest(null)).toBeNull()
    expect(drainTopicSplitRequest('g1')).toEqual({ chatId: 't1', name: '北京天气', sourceChatId: 'g1' })
    // 一次性:聊天区挂载时与收到事件时各取一次,❌ 不许开两回。
    expect(drainTopicSplitRequest('g1')).toBeNull()
  })

  it('请求发出去就叫醒一声 —— 聊天区已经挂着的那种情况靠它，没挂的靠挂载时自己来取', async () => {
    const { requestTopicSplit } = await import('../../../apps/desktop/src/lib/topicSplitRequest')
    const { UI_EVENTS } = await import('../../../apps/desktop/src/lib/uiEvents')
    const heard: string[] = []
    const listener = () => heard.push('woke')
    window.addEventListener(UI_EVENTS.openTopicSplit, listener)
    requestTopicSplit({ chatId: 't2', name: 'x', sourceChatId: 'g2' })
    window.removeEventListener(UI_EVENTS.openTopicSplit, listener)
    expect(heard).toEqual(['woke'])
  })

  it('点完话题又去点了别处：过期的请求作废，❌ 不许日后回到那条线时突然自己弹出来', async () => {
    const { requestTopicSplit, drainTopicSplitRequest } =
      await import('../../../apps/desktop/src/lib/topicSplitRequest')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    requestTopicSplit({ chatId: 't3', name: 'y', sourceChatId: 'g3' })
    vi.mocked(Date.now).mockReturnValue(now + 15_001)
    expect(drainTopicSplitRequest('g3')).toBeNull()
    vi.mocked(Date.now).mockRestore()
  })
})


describe('话题面板搜索、分页与「更多」导航', () => {
  const baseProps = { attachments: [], onOpenFile: vi.fn(), onDownloadFile: vi.fn(), onClose: vi.fn() }
  const topics = Array.from({ length: 200 }, (_, index) => ({
    chatId: `history-${index}`, title: index === 199 ? 'Release 发布复盘' : `话题 ${index}`,
    participantCount: 1, messageCount: 2, lastMessageAt: null, isParticipant: index % 2 === 0,
  }))

  it('在完整列表中搜索,叠加「我的」筛选,清除搜索后回到首批', async () => {
    const { HistoryPanel } = await import('../../../apps/desktop/src/components/HistoryPanel')
    const observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class { observe = observe; disconnect = vi.fn() })
    try {
      const onOpenTopic = vi.fn()
      await renderWithAppProviders(harness, createNode(HistoryPanel, { ...baseProps, mode: 'group', topics, onOpenTopic }), { chat: {} })
      const cards = () => harness.container.querySelectorAll('[data-testid="history-topic-card"]')
      expect(cards()).toHaveLength(30)
      const input = harness.container.querySelector('input[type="search"]') as HTMLInputElement
      await typeInto(input, '  RELEASE  ')
      expect(cards()).toHaveLength(1)
      expect(cards()[0].textContent).toContain('Release 发布复盘')
      await clickElement(cards()[0] as HTMLElement)
      expect(onOpenTopic).toHaveBeenCalledWith('history-199', 'Release 发布复盘')
      const filter = (label: string) => Array.from(harness.container.querySelectorAll('button')).find((node) => node.textContent === label) as HTMLElement
      await clickElement(filter('我的'))
      expect(cards()).toHaveLength(0)
      expect(harness.container.textContent).toContain('未找到匹配的话题')
      await clickElement(filter('全部'))
      expect(cards()).toHaveLength(1)
      await clickElement(harness.container.querySelector('[aria-label="清除搜索"]') as HTMLElement)
      expect(cards()).toHaveLength(30)
      expect(input.value).toBe('')
    } finally { vi.unstubAllGlobals() }
  })

  it('滚到面板底部才接下一批;过期 observer 不得在搜索后多接一批', async () => {
    const { HistoryPanel } = await import('../../../apps/desktop/src/components/HistoryPanel')
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
    const roots: Array<Element | Document | null | undefined> = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof callbacks[number], options: IntersectionObserverInit) { callbacks.push(callback); roots.push(options.root) }
      observe = vi.fn()
      disconnect = vi.fn()
    })
    try {
      await renderWithAppProviders(harness, createNode(HistoryPanel, { ...baseProps, mode: 'group', topics, onOpenTopic: vi.fn() }), { chat: {} })
      const count = () => harness.container.querySelectorAll('[data-testid="history-topic-card"]').length
      expect(roots[0]).toBe(harness.container.querySelector('.gg-hist-body'))
      await act(async () => callbacks[0]([{ isIntersecting: false }]))
      expect(count()).toBe(30)
      await act(async () => callbacks[0]([{ isIntersecting: true }]))
      expect(count()).toBe(60)
      const oldCallback = callbacks.at(-1)!
      await typeInto(harness.container.querySelector('input') as HTMLInputElement, '话题')
      expect(count()).toBe(30)
      await act(async () => oldCallback([{ isIntersecting: true }]))
      expect(count()).toBe(30)
      for (let page = 1; page < 7; page++) {
        await act(async () => callbacks.at(-1)!([{ isIntersecting: true }]))
      }
      expect(count()).toBe(199)
      expect(harness.container.querySelector('[data-testid="history-topics-next-page"]')).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('私聊常规打开仍是导入历史;明确的话题入口落在话题', async () => {
    const { HistoryPanel } = await import('../../../apps/desktop/src/components/HistoryPanel')
    const props = { ...baseProps, mode: 'private' as const, topics: topics.slice(0, 1), onOpenTopic: vi.fn(), importedHistory: '导入记录内容' }
    await renderWithAppProviders(harness, createNode(HistoryPanel, { ...props, key: 'normal' }), { chat: {} })
    expect(harness.container.textContent).toContain('导入记录内容')
    expect(harness.container.querySelector('input')).toBeNull()
    await renderWithAppProviders(harness, createNode(HistoryPanel, { ...props, key: 'more', initialTab: 'topics' }), { chat: {} })
    expect(harness.container.textContent).not.toContain('导入记录内容')
    expect(harness.container.querySelectorAll('[data-testid="history-topic-card"]')).toHaveLength(1)
  })

  it('跨会话请求等目标会话重置完才打开;已开面板时每次点更多也切回话题', async () => {
    const { useTopicsPanelRequest } = await import('../../../apps/desktop/src/hooks/useTopicsPanelRequest')
    const { requestTopicsPanel, drainTopicsPanelRequest } = await import('../../../apps/desktop/src/lib/topicsPanelRequest')
    function Surface({ chatId, openNonce }: { chatId: string; openNonce?: number }) {
      const [tab, setTab] = useState('closed')
      useEffect(() => setTab('closed'), [chatId, openNonce])
      const onOpen = useCallback(() => setTab('topics'), [])
      useTopicsPanelRequest(chatId, openNonce, onOpen)
      return createElement('button', { onClick: () => setTab('attachments') }, tab)
    }
    await harness.render(createNode(Surface, { chatId: 'old-chat' }))
    await act(async () => requestTopicsPanel('next-chat'))
    expect(harness.container.textContent).toBe('closed')
    await harness.render(createNode(Surface, { chatId: 'next-chat' }))
    expect(harness.container.textContent).toBe('topics')
    expect(drainTopicsPanelRequest('next-chat')).toBe(false)
    await clickElement(harness.container.querySelector('button') as HTMLElement)
    expect(harness.container.textContent).toBe('attachments')
    await act(async () => requestTopicsPanel('next-chat'))
    expect(harness.container.textContent).toBe('topics')
    await clickElement(harness.container.querySelector('button') as HTMLElement)
    await act(async () => {
      requestTopicsPanel('next-chat')
      await harness.render(createNode(Surface, { chatId: 'next-chat', openNonce: 1 }))
    })
    expect(harness.container.textContent).toBe('topics')
    const { useMobileChatOpenNonce } = await import('../../../apps/desktop/src/hooks/useMobileChatOpenNonce')
    function MobileSurface({ pane }: { pane: 'list' | 'chat' }) {
      const openNonce = useMobileChatOpenNonce(true, pane)
      return createNode(Surface, { chatId: 'next-chat', openNonce })
    }
    await harness.render(createNode(MobileSurface, { pane: 'list' }))
    await act(async () => {
      requestTopicsPanel('next-chat')
      await harness.render(createNode(MobileSurface, { pane: 'chat' }))
    })
    expect(harness.container.textContent).toBe('topics')
    await harness.render(createNode(MobileSurface, { pane: 'list' }))
    await harness.render(createNode(MobileSurface, { pane: 'chat' }))
    expect(harness.container.textContent).toBe('closed')
  })
})
