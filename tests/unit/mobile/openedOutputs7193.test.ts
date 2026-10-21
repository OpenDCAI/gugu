import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionpageOpenedFileChunk, SessionpageOpenedFileReadRequest } from '@gugu/session-core/session-record/contract'
import { OUTPUTS_DATA_PART, toThreadMessages, unsettledLastTurnId, type OpenedOutputsData } from '@/mobile/agent-watch/thread-messages'
import { OpenedFileChangedError, phoneOpenPlan, readWholeOpenedFile } from '@/mobile/agent-watch/opened-output-open'
import { ROW_INSET_X } from '@gugu/session-chat-ui/layout-geometry'

/**
 * 手机会话页的附件卡(#7193):agent 用 open_in_tab 打开给人看的文件 / 网页,挂在这一轮最后那条回复下面;
 * 点开:网页交给浏览器,文件从那台电脑按块现读。判据喂合成输入(形状取自真实记录)。
 */

type Item = TranscriptTurn['items'][number]
const user = (id: string, text = '做个汇报') => ({ kind: 'message', id, seq: 0, role: 'user', text }) as Item
const reply = (id: string, text = '汇报做好了') => ({ kind: 'message', id, seq: 0, role: 'assistant', text }) as Item
const open = (id: string, target: { path?: string; url?: string }, status: 'done' | 'error' = 'done') =>
  ({
    kind: 'mcp-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'mcp__gugu__session_open_in_tab',
    server: 'gugu',
    tool: 'session_open_in_tab',
    status,
    rawInput: JSON.stringify(target),
    outputText: JSON.stringify(status === 'done' ? { opened: true, ...target, intent: 'pinned' } : { error: 'nope' }),
    parentToolCallId: null,
  }) as unknown as Item

function turn(id: string, items: Item[]): TranscriptTurn {
  return { id, seq: 1, initiator: 'user', items, outcome: { kind: 'done' } } as TranscriptTurn
}

const outputsParts = (messages: ReturnType<typeof toThreadMessages>) =>
  messages.flatMap((message) =>
    (Array.isArray(message.content) ? message.content : []).filter(
      (part): part is { type: 'data'; name: string; data: OpenedOutputsData } =>
        typeof part === 'object' && part.type === 'data' && part.name === OUTPUTS_DATA_PART,
    ),
  )

describe('时间线 → 手机消息:附件卡挂在这一轮最后', () => {
  it('卡片在最后那条回复的同一条消息里、正文之后;打开那一步照常在折起来的过程里(与桌面同一个样子)', () => {
    const messages = toThreadMessages([turn('t1', [user('u1'), open('o1', { path: '/r/report.html' }), reply('a1')])])
    const last = messages.at(-1)!
    expect(last.role).toBe('assistant')
    const parts = last.content as readonly { type: string; name?: string }[]
    expect(parts.map((part) => part.type)).toEqual(['text', 'data'])
    expect(parts[1]?.name).toBe(OUTPUTS_DATA_PART)
    const toolCalls = messages.slice(0, -1).flatMap((m) => (m.content as readonly { type: string; toolCallId?: string }[]).filter((p) => p.type === 'tool-call'))
    expect(toolCalls.map((part) => part.toolCallId)).toEqual(['o1'])
    // 交出去的是记下它的那条调用本身:手机拿它去画桌面同一张卡
    expect(outputsParts(messages)[0]?.data.items.map((item) => item.id)).toEqual(['o1'])
  })

  it('同一份开了几次只挂一张;失败的那一次不挂卡,只在过程里', () => {
    const messages = toThreadMessages([
      turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), open('o2', { path: '/gone.html' }, 'error'), open('o3', { path: '/r/a.html' }), reply('a1')]),
    ])
    expect(outputsParts(messages)[0]?.data.items.map((item) => item.id)).toEqual(['o3'])
    const steps = messages.flatMap((m) => (m.content as readonly { type: string; toolCallId?: string }[]).filter((p) => p.type === 'tool-call'))
    expect(steps.map((part) => part.toolCallId)).toEqual(['o1', 'o2', 'o3'])
  })

  it('没有打开过任何东西的一轮没有卡片', () => {
    expect(outputsParts(toThreadMessages([turn('t1', [user('u1'), reply('a1')])]))).toEqual([])
  })

  it('在跑的一轮不挂卡(打开那一步照常在过程里);前面跑完的一轮照挂', () => {
    const done = turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), reply('a1')])
    const live = { ...turn('t2', [user('u2'), open('o2', { path: '/r/b.html' })]), outcome: undefined }
    const messages = toThreadMessages([done, live], { liveTurnId: 't2' })
    expect(outputsParts(messages).map((part) => part.data.turnId)).toEqual(['t1'])
    const steps = messages.flatMap((m) => (m.content as readonly { type: string; toolCallId?: string }[]).filter((p) => p.type === 'tool-call'))
    expect(steps.map((part) => part.toolCallId)).toEqual(['o1', 'o2'])
  })

  it('等审批 / 提问时这一轮也还没结算:不挂卡(同桌面的活动层);结算了才挂', () => {
    const waiting = { ...turn('t1', [user('u1'), open('o1', { path: '/r/a.html' })]), outcome: undefined }
    const settlements = { o9: { itemId: 'o9', state: 'pending' } }
    expect(unsettledLastTurnId([waiting])).toBe('t1')
    expect(outputsParts(toThreadMessages([waiting], { liveTurnId: unsettledLastTurnId([waiting]), settlements }))).toEqual([])
    const settled = turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), reply('a1')])
    expect(unsettledLastTurnId([settled])).toBeNull()
    expect(outputsParts(toThreadMessages([settled], { liveTurnId: unsettledLastTurnId([settled]) })).map((part) => part.data.turnId)).toEqual(['t1'])
  })
})

describe('手机上卡片与正文对齐', () => {
  it('opened-outputs-part 的 -mx-4 抵的正是转录的行缩进;缩进改了这里要一起改', () => {
    expect(ROW_INSET_X).toBe(16)
  })
})

describe('手机上点开怎么开', () => {
  it('公网网页交给浏览器;那台电脑自己的网页如实说开不了', () => {
    expect(phoneOpenPlan({ kind: 'page', url: 'https://github.com/a' })).toEqual({ kind: 'browser', url: 'https://github.com/a' })
    expect(phoneOpenPlan({ kind: 'page', url: 'http://127.0.0.1:4187/zh/' })).toEqual({ kind: 'machine-only' })
  })

  it('文件:汇报走预览,图走看图器;file:// 打开的网页也是那台电脑上的文件', () => {
    expect(phoneOpenPlan({ kind: 'file', path: '/r/汇报.html' })).toMatchObject({ kind: 'file', path: '/r/汇报.html', name: '汇报.html', view: 'html' })
    expect(phoneOpenPlan({ kind: 'file', path: '/r/a.png' })).toMatchObject({ kind: 'file', view: 'image', mimeType: 'image/png' })
    expect(phoneOpenPlan({ kind: 'file', path: '/r/a.pdf' })).toMatchObject({ view: 'pdf' })
    expect(phoneOpenPlan({ kind: 'page', url: 'file:///tmp/r/index.html' })).toMatchObject({ kind: 'file', path: '/tmp/r/index.html', view: 'html' })
  })
})

describe('从那台电脑按块读整份', () => {
  const bytes = new Uint8Array(1_200_000).map((_, i) => i % 251)
  const chunkReader = (source: Uint8Array, etagAt: (offset: number) => string = () => 'v1') => {
    const requests: SessionpageOpenedFileReadRequest[] = []
    const read = async (request: SessionpageOpenedFileReadRequest): Promise<SessionpageOpenedFileChunk> => {
      requests.push(request)
      const slice = source.subarray(request.offset, request.offset + request.length)
      return { size: source.length, etag: etagAt(request.offset), data: Buffer.from(slice).toString('base64') }
    }
    return { read, requests }
  }

  it('几块拼回原字节,一块不多一块不少', async () => {
    const { read, requests } = chunkReader(bytes)
    const whole = await readWholeOpenedFile({ read, conversationId: 'c1', path: '/r/big.bin' })
    expect(Buffer.from(whole).equals(Buffer.from(bytes))).toBe(true)
    expect(requests.length).toBe(3)
    expect(requests.every((request) => request.conversationId === 'c1' && request.path === '/r/big.bin')).toBe(true)
  })

  it('每读到一块报一次进度:累计字节与总大小(大文件要等一会儿,等的时候看得到在动)', async () => {
    const { read } = chunkReader(bytes)
    const progress: Array<[number, number]> = []
    await readWholeOpenedFile({ read, conversationId: 'c1', path: '/r/big.bin', onProgress: (done, size) => progress.push([done, size]) })
    expect(progress).toEqual([
      [524_288, 1_200_000],
      [1_048_576, 1_200_000],
      [1_200_000, 1_200_000],
    ])
  })

  it('空文件读一次就完', async () => {
    const { read, requests } = chunkReader(new Uint8Array(0))
    expect((await readWholeOpenedFile({ read, conversationId: 'c1', path: '/e' })).length).toBe(0)
    expect(requests.length).toBe(1)
  })

  it('读到一半文件被改了:报出来,❌ 交出两个版本拼成的一份', async () => {
    const { read } = chunkReader(bytes, (offset) => (offset === 0 ? 'v1' : 'v2'))
    await expect(readWholeOpenedFile({ read, conversationId: 'c1', path: '/r/big.bin' })).rejects.toBeInstanceOf(OpenedFileChangedError)
  })

  it('关掉预览就不再往下读', async () => {
    const controller = new AbortController()
    const { requests } = chunkReader(bytes)
    const read = async (request: SessionpageOpenedFileReadRequest) => {
      requests.push(request)
      controller.abort()
      return { size: bytes.length, etag: 'v1', data: Buffer.from(bytes.subarray(0, request.length)).toString('base64') }
    }
    await expect(readWholeOpenedFile({ read, conversationId: 'c1', path: '/r/big.bin', signal: controller.signal })).rejects.toThrow()
    expect(requests.length).toBe(1)
  })
})
