import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { runningToolIds, toolImagesById, toThreadMessages } from '@/mobile/agent-watch/thread-messages'

/**
 * 时间线 → assistant-ui 消息模型。三种失败模式各钉一条：少一条、顺序乱、角色错。
 * 判据喂合成输入，所以每条都构造得出必失败条件。
 */

function turn(id: string, items: TranscriptTurn['items']): TranscriptTurn {
  return { id, seq: 1, initiator: 'user', items } as TranscriptTurn
}

const userItem = (id: string, text: string) =>
  ({ kind: 'message', id, seq: 0, role: 'user', text }) as TranscriptTurn['items'][number]
const agentItem = (id: string, text: string) =>
  ({ kind: 'message', id, seq: 1, role: 'assistant', text }) as TranscriptTurn['items'][number]
// ToolNode 是按工具种类分的联合(WebFetchToolCall 之类各有必填字段),合成一条测试用的
// 工具调用只能双重断言 —— 这里要的是「转换器怎么对待一条工具项」,不是复刻某一家的形状。
const toolItem = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'tool-call', id, seq: 2, title, status: 'done', ...extra }) as unknown as TranscriptTurn['items'][number]

describe('时间线转 assistant-ui 消息', () => {
  it('用户一句 + agent 一句 ⇒ 两条消息,角色与顺序都对', () => {
    const out = toThreadMessages([turn('t1', [userItem('u1', '你好'), agentItem('a1', '在的')])])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(out[0].content).toEqual([{ type: 'text', text: '你好' }])
    expect(out[1].content).toEqual([{ type: 'text', text: '在的' }])
  })

  // #6737 输入框附件发出去是正文里的 `@[名字](绝对路径)`;气泡上画成附件,❌ 摆一长串路径。判据与桌面同一份(splitAttachmentMentions)。
  it('指着绝对路径的文件 mention 拆成附件;相对路径是正文里的引用,不动;只有附件时没有文字气泡;id 仍是那一行的 id', () => {
    const [withText, onlyFiles, inline] = toThreadMessages([
      turn('t1', [
        userItem('u1', '看看这两个\n@[a b.png](</m/att/a b.png>)\n@[notes.txt](/m/att/notes.txt)'),
        userItem('u2', '@[x.pdf](/m/att/x.pdf)'),
        userItem('u3', '比较 @[a.txt](src/a.txt) 和它\n谢谢'),
      ]),
    ])
    expect(withText.id).toBe('u1')
    expect(withText.content).toEqual([{ type: 'text', text: '看看这两个' }])
    expect(withText.attachments?.map((a) => a.name)).toEqual(['a b.png', 'notes.txt'])
    expect(onlyFiles.content).toEqual([])
    expect(onlyFiles.attachments?.map((a) => a.name)).toEqual(['x.pdf'])
    // 阴控:相对路径 ⇒ 是话里提到的文件,原样留着
    expect(inline.content).toEqual([{ type: 'text', text: '比较 @[a.txt](src/a.txt) 和它\n谢谢' }])
    expect(inline.attachments).toBeUndefined()
  })

  it('一轮里出现第二句用户消息时,先把攒着的 agent 内容收口 —— ❌ 顺序不许乱', () => {
    const out = toThreadMessages([
      turn('t1', [userItem('u1', '第一问'), agentItem('a1', '第一答'), userItem('u2', '第二问')]),
    ])
    // 收不了口的话「第二问」会排到「第一答」前面(或被并进同一条 assistant 消息)。
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[2].content).toEqual([{ type: 'text', text: '第二问' }])
  })

  it('工具卡的 toolCallId 用的是**我们的 item id**(一条线里唯一),不是 provider 的 toolCallId', () => {
    const out = toThreadMessages([
      turn('t1', [toolItem('item-9', '写文件', { toolCallId: 'provider-abc' })]),
    ])
    const part = out[0].content[0] as { type: string; toolCallId: string }
    expect(part.type).toBe('tool-call')
    expect(part.toolCallId).toBe('item-9')
  })

  // 2026-10-12 owner 手机实测:结算按 provider 的 toolCallId 记,从前拿 item id 去找卡,永远找不到 ⇒ 卡只能钉在末尾。
  it('有结算的那次调用画成卡(`question` part,按 provider 的 toolCallId 认),❌ 再交一张通用工具卡', () => {
    const ask = toolItem('t1:tool:toolu_1', 'AskUserQuestion', { toolCallId: 'toolu_1' })
    const [card] = toThreadMessages([turn('t1', [ask])], { settlements: { toolu_1: {} } })
    expect(card.content).toEqual([{ type: 'data', name: 'question', data: ask }])
    // 阴控:拿 item id 去对(从前的做法)/ 没有结算 ⇒ 照旧一张工具卡
    for (const settlements of [{ 't1:tool:toolu_1': {} }, {}]) {
      const [row] = toThreadMessages([turn('t1', [ask])], { settlements })
      expect((row.content[0] as { type: string }).type).toBe('tool-call')
    }
  })

  it('嵌套的子工具调用要摊平出来,❌ 不许整棵丢掉', () => {
    const out = toThreadMessages([
      turn('t1', [
        toolItem('group-1', '一组', {
          kind: 'tool-group',
          label: '一组',
          children: [toolItem('child-1', '子调用')],
        }),
      ]),
    ])
    const ids = (out[0].content as unknown as Array<{ toolCallId?: string }>).map((p) => p.toolCallId)
    expect(ids).toEqual(['group-1', 'child-1'])
  })

  it('空轮不产出空消息(❌ 屏幕上不许出现一条什么都没有的气泡)', () => {
    expect(toThreadMessages([turn('t1', [])])).toEqual([])
  })

  it('上游造的占位标题不许上屏,退回工具自己报的名字', () => {
    // item-fold.ts 在事件没带标题时写 `title: event.title ?? 'unknown'` —— 那是内部记号,
    // 原样印在中文界面上就是一个没头没脑的英文词(真机截图上出现过)。
    const out = toThreadMessages([
      turn('t1', [
        toolItem('item-1', 'unknown', {
          kind: 'unknown-tool-call',
          name: 'grep_files',
          toolKind: 'search'
        })
      ])
    ])
    const part = out[0].content[0] as { toolName: string }
    expect(part.toolName).toBe('grep_files')
    expect(part.toolName).not.toBe('unknown')
  })

  it('`name` 只是 title 的拷贝,带着同一个占位记号时也不许上屏(真机上被骗的就是这一环)', () => {
    const out = toThreadMessages([
      turn('t1', [
        toolItem('i1', 'unknown', { kind: 'unknown-tool-call', name: 'unknown', toolKind: 'search' })
      ])
    ])
    expect((out[0].content[0] as { toolName: string }).toolName).toBe('search')
  })

  it('占位标题 + 没有原名时退到 ACP 种类;两样都没有就交空串给渲染件兜文案', () => {
    const withKind = toThreadMessages([
      turn('t1', [toolItem('i1', 'unknown', { kind: 'unknown-tool-call', name: '', toolKind: 'execute' })])
    ])
    expect((withKind[0].content[0] as { toolName: string }).toolName).toBe('execute')

    const bare = toThreadMessages([
      turn('t2', [toolItem('i2', 'unknown', { kind: 'unknown-tool-call', name: '', toolKind: null })])
    ])
    // ❌ 文案不进这个纯函数:空串是「我没有名字」,由组件用本地化文案说人话。
    expect((bare[0].content[0] as { toolName: string }).toolName).toBe('')
  })

  it('反向对照:真标题原样留着,❌ 不许被回退链吃掉', () => {
    const out = toThreadMessages([
      turn('t1', [toolItem('i1', '读 src/main.ts', { kind: 'unknown-tool-call', name: 'read', toolKind: 'read' })])
    ])
    expect((out[0].content[0] as { toolName: string }).toolName).toBe('读 src/main.ts')
  })

  it('经 catalog_call 跑的工具写它自己的名字 —— 和桌面工具行同一个 toolDisplayName', () => {
    const out = toThreadMessages([
      turn('t1', [
        toolItem('i1', 'mcp__plugin_gugu-product_gugu__catalog_call', {
          kind: 'mcp-tool-call',
          server: 'plugin_gugu-product_gugu',
          tool: 'catalog_call',
          rawInput: JSON.stringify({ tool: 'dice__roll', args: {} })
        })
      ])
    ])
    expect((out[0].content[0] as { toolName: string }).toolName).toBe('dice__roll')
  })

  it('catalog_call 那张卡的灰字预览看代跑那次调用自己的 args,❌ 再写一遍工具名', () => {
    const card = (args: unknown) => toThreadMessages([
      turn('t1', [toolItem('i1', 'mcp__gugu__catalog_call', { kind: 'mcp-tool-call', server: 'gugu', tool: 'catalog_call', rawInput: JSON.stringify({ tool: 'browser__open', args }) })])
    ])[0].content[0] as { toolName: string; args: { summary?: string } }
    expect(card({ url: 'https://example.com/a' })).toMatchObject({ toolName: 'browser__open', args: { summary: 'https://example.com/a' } })
    expect(card({}).args.summary).toBeUndefined()
  })

  it('往前补进更早的轮,已有的每条消息 id 不变(#6726:换 id 会让回复挂到别的提问下面)', () => {
    const later = [turn('t3', [userItem('u3', '三'), agentItem('a3', '答三')]), turn('t4', [userItem('u4', '四'), agentItem('a4', '答四')])]
    const older = [turn('t1', [userItem('u1', '一'), agentItem('a1', '答一')]), turn('t2', [userItem('u2', '二'), agentItem('a2', '答二')])]
    const before = toThreadMessages(later).map((m) => m.id)
    const after = toThreadMessages([...older, ...later]).map((m) => m.id)
    expect(after.slice(-before.length)).toEqual(before)
    expect(new Set(after).size).toBe(after.length)
  })

  it('阳性对照:同一批转两次结果一致(纯函数,没有藏状态)', () => {
    const input = [turn('t1', [userItem('u1', '你好'), agentItem('a1', '在的')])]
    expect(toThreadMessages(input)).toEqual(toThreadMessages(input))
  })
})

/**
 * 手机会话页的思考与过程折叠对齐桌面(shuxue 2026-09-29「手机端对齐桌面端就行」):
 * 思考整条交给桌面那一行;一轮的过程收在桌面同款时间头下,判断是同一份(turn-fold)。
 */
describe('思考与过程折叠(同桌面)', () => {
  const thinkingItem = (id: string, status: 'thinking' | 'done', text: string) =>
    ({ kind: 'thinking', id, seq: 1, status, text, startedAt: 1_000 }) as TranscriptTurn['items'][number]
  const timed = (t: TranscriptTurn, startedAt: number, endedAt?: number) => ({ ...t, startedAt, ...(endedAt !== undefined ? { endedAt } : {}) }) as TranscriptTurn
  type Meta = { custom?: { turnProcess?: { id: string; live: boolean; startedAt?: number; endedAt?: number } } }
  const header = (m: { metadata?: unknown }) => (m.metadata as Meta | undefined)?.custom?.turnProcess

  it('思考整条原样交出去(正文、状态都在),❌ 不再压成一个「…」', () => {
    const out = toThreadMessages([turn('t1', [userItem('u1', '算一下'), thinkingItem('th1', 'thinking', '先算 9:47 到 13:26')])], { liveTurnId: 't1' })
    const parts = out.flatMap((m) => m.content as unknown as Array<{ type: string; name?: string; data?: { text?: string; status?: string } }>)
    const thinking = parts.find((p) => p.type === 'data' && p.name === 'thinking')
    expect(thinking?.data).toMatchObject({ text: '先算 9:47 到 13:26', status: 'thinking' })
    expect(parts.some((p) => p.type === 'reasoning')).toBe(false)
  })

  it('跑完的一轮:过程(思考 + 工具)单独一条、挂「用时」头;最后一句回复在头外面', () => {
    const out = toThreadMessages([
      timed(turn('t1', [userItem('u1', '跑一下'), thinkingItem('th1', 'done', '先看看'), toolItem('c1', 'Bash'), agentItem('a1', '好了')]), 1_000, 43_000),
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(header(out[1])).toEqual({ id: 't1:process', live: false, startedAt: 1_000, endedAt: 43_000 })
    expect((out[1].content as unknown as Array<{ type: string }>).map((p) => p.type)).toEqual(['data', 'tool-call'])
    expect(header(out[2])).toBeUndefined()
    expect(out[2].content).toEqual([{ type: 'text', text: '好了' }])
  })

  it('在跑的那一轮:头是活的(在数秒、默认摊开);前面结算过的轮不受影响', () => {
    const done = timed(turn('t1', [userItem('u1', '一'), toolItem('c1', 'Read'), agentItem('a1', '答一')]), 1_000, 2_000)
    const live = timed(turn('t2', [userItem('u2', '二'), toolItem('c2', 'Bash')]), 3_000)
    const out = toThreadMessages([done, live], { liveTurnId: 't2' })
    const heads = out.map(header).filter(Boolean)
    expect(heads).toEqual([
      { id: 't1:process', live: false, startedAt: 1_000, endedAt: 2_000 },
      { id: 't2:process', live: true, startedAt: 3_000 },
    ])
  })

  // owner 2026-10-22(#69):agent 自己开头的一轮跑完了也折,只留最后一句话;一句没说的照旧平铺(同桌面)。
  it('agent 自己发起、说了话的一轮:跑完折成一个头,那句话在外面', () => {
    const agentTurn = { ...timed(turn('t1', [toolItem('c1', 'Bash'), agentItem('a1', '后台跑完了')]), 1_000, 5_000), initiator: 'agent' } as TranscriptTurn
    const out = toThreadMessages([agentTurn])
    expect(out.map(header).filter(Boolean)).toEqual([{ id: 't1:process', live: false, startedAt: 1_000, endedAt: 5_000 }])
    expect(out.at(-1)?.content).toEqual([{ type: 'text', text: '后台跑完了' }])
  })

  it('agent 自己发起、一句没说的一轮,或还在跑的那一轮:不画头,平铺', () => {
    const silent = { ...timed(turn('t1', [toolItem('c1', 'Bash')]), 1_000, 2_000), initiator: 'agent' } as TranscriptTurn
    expect(toThreadMessages([silent]).every((m) => header(m) === undefined)).toBe(true)
    const running = { ...timed(turn('t2', [toolItem('c2', 'Bash'), agentItem('a2', '在查')]), 3_000), initiator: 'agent' } as TranscriptTurn
    expect(toThreadMessages([running], { liveTurnId: 't2' }).every((m) => header(m) === undefined)).toBe(true)
  })

  it('`[NO_REPLY]` 不画成一句话(同桌面,#70 review)', () => {
    const agentTurn = { ...turn('t1', [toolItem('c1', 'Bash'), agentItem('a1', '[NO_REPLY]')]), initiator: 'agent' } as TranscriptTurn
    const texts = toThreadMessages([agentTurn]).flatMap((m) => (m.content as unknown as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text'))
    expect(texts).toEqual([])
  })

  it('人问的那一轮没收尾、下一轮 agent 接着干完 ⇒ 并成一个头,回复在外面(同桌面 #4981 合并)', () => {
    const ask = timed(turn('t1', [userItem('u1', '做吧'), toolItem('c1', 'Read')]), 1_000, 2_000)
    const cont = { ...timed(turn('t2', [toolItem('c2', 'Bash'), agentItem('a2', '做完了')]), 2_500, 9_000), initiator: 'agent' } as TranscriptTurn
    const out = toThreadMessages([ask, cont])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(header(out[1])).toEqual({ id: 't1:process', live: false, startedAt: 1_000, endedAt: 9_000 })
    expect((out[1].content as unknown as Array<{ toolCallId?: string }>).map((p) => p.toolCallId)).toEqual(['c1', 'c2'])
    expect(out[2].content).toEqual([{ type: 'text', text: '做完了' }])
  })

  // owner 10-07:手机上发完一句,上游首字节要几十秒,那段时间消息下面什么都没有,像是没发出去。桌面有一行在数秒。
  it('在跑的那一轮还什么都没有:时间头已经在数秒(空的过程消息),id 与思考到了之后那一条相同', () => {
    const before = toThreadMessages([timed(turn('t1', [userItem('u1', '算一下')]), 3_000)], { liveTurnId: 't1' })
    expect(before.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(header(before[1])).toEqual({ id: 't1:process', live: true, startedAt: 3_000 })
    expect(before[1].content).toEqual([])
    const after = toThreadMessages([timed(turn('t1', [userItem('u1', '算一下'), thinkingItem('th1', 'thinking', '先乘')]), 3_000)], { liveTurnId: 't1' })
    expect(after[1].id).toBe(before[1].id)
    expect(header(after[1])).toEqual(header(before[1]))
  })

  it('❌ 不在跑的轮、或已经开口的轮不画这个空头', () => {
    // 阴控 1:同一轮没在跑(落定 / 机器没说它在跑)⇒ 只有那一句
    expect(toThreadMessages([timed(turn('t1', [userItem('u1', '算一下')]), 3_000)]).map((m) => m.role)).toEqual(['user'])
    // 阴控 2:在跑但已经有回复在写 ⇒ 回复本身就是动静,不再挂空头
    const talking = toThreadMessages([timed(turn('t1', [userItem('u1', '在吗'), agentItem('a1', '在')]), 3_000)], { liveTurnId: 't1' })
    expect(talking.every((m) => header(m) === undefined)).toBe(true)
  })
})

/**
 * agent 消息的状态写明,❌ 留给 assistant-ui 推:没出结果的工具卡拿的是消息的状态,而手机线程的 isRunning 只算
 * 「这台手机正在发」⇒ 推出来是 requires-action,一条跑着的 Bash 就摊开画「允许 / 拒绝」(设计同事 10-05 真机)。
 * 运行态按卡给(runningToolIds):一条消息里跑完的和在跑的混在一起,消息的状态分不开它们。
 */
describe('agent 消息的状态与在跑的工具', () => {
  const turns = [
    turn('t1', [userItem('u1', '先看看'), toolItem('x1', 'Bash', { outputText: 'ok' }), agentItem('a1', '看完了')]),
    turn('t2', [userItem('u2', '建目录再等'), toolItem('x2', 'mkdir'), toolItem('x3', 'Bash', { status: 'running' })]),
  ]

  it('每条 agent 消息都写明 complete —— 有工具在跑的那条也是', () => {
    const assistants = toThreadMessages(turns).filter((m) => m.role === 'assistant')
    expect(assistants.length).toBeGreaterThan(0)
    expect(assistants.map((m) => m.status)).toEqual(assistants.map(() => ({ type: 'complete', reason: 'unknown' })))
  })

  it('在跑的只有数据里 running 的那一条;跑完却没有输出的不算', () => {
    expect([...runningToolIds(turns)]).toEqual(['x3'])
  })
})

/**
 * 折叠行的入参预览。orca 那一行是 `▸ 工具名 <预览>`，咕咕这边 provider 多半不给
 * `inputSummary`（2026-09-05 真机实测 Claude 的 Bash/Read 都不给），所以必须能从 `rawInput`
 * 算出来 —— 算不出就**不显示**，❌ 不硬凑一段看着像读数的东西。
 */
describe('工具折叠行的入参预览', () => {
  const summaryOf = (extra: Record<string, unknown>) => {
    const out = toThreadMessages([turn('t1', [toolItem('x1', 'Bash', extra)])])
    const part = out[0].content[0] as { args?: { summary?: string } }
    return part.args?.summary
  }

  it('provider 给了 inputSummary 就用它的', () => {
    expect(summaryOf({ inputSummary: '跑一遍单测', rawInput: '{"command":"pnpm test"}' })).toBe(
      '跑一遍单测'
    )
  })

  it('没有 inputSummary 时从 rawInput 里挑 command —— 这是真机上的常态', () => {
    expect(summaryOf({ rawInput: '{"command":"pnpm test:unit","timeout":600}' })).toBe(
      'pnpm test:unit'
    )
  })

  it('挑得出文件路径', () => {
    expect(summaryOf({ rawInput: '{"file_path":"apps/desktop/src/main.ts"}' })).toBe(
      'apps/desktop/src/main.ts'
    )
  })

  it('过长的截断并留省略号 —— 一行放不下', () => {
    const long = 'x'.repeat(120)
    const got = summaryOf({ rawInput: JSON.stringify({ command: long }) })
    expect(got).toHaveLength(48)
    expect(got?.endsWith('…')).toBe(true)
  })

  it('❌ 挑不出可读字段时不给预览(阴控:入参全是数字)', () => {
    expect(summaryOf({ rawInput: '{"offset":10,"limit":20}' })).toBeUndefined()
  })

  it('❌ 完全没有入参时不给预览', () => {
    expect(summaryOf({})).toBeUndefined()
  })

  it('rawInput 不是 JSON 时当整串是参数(有的 provider 直接给一行命令)', () => {
    expect(summaryOf({ rawInput: 'ls -la /tmp' })).toBe('ls -la /tmp')
  })
})

/**
 * 传输层裁过的那条工具调用要把「少了多少字」画出来 —— 一次看不出来的截断等于给了一个错的读数,
 * 人会以为输出到此为止(owner 2026-09-08 拍板裁,前提是裁了要说)。
 */
describe('被裁过的工具输出', () => {
  const note = (chars: number) => `… 已截断 ${chars} 字 · 在桌面上看完整输出`

  it('输出后面接上那一句;字数是机器报的那个数', () => {
    const out = toThreadMessages(
      [turn('t1', [toolItem('x1', 'cat big.txt', { outputText: '前 8K', trimmedChars: 40327 })])],
      { trimmedNote: note },
    )
    const part = out[0].content[0] as { result: string }
    expect(part.result).toBe('前 8K\n\n… 已截断 40327 字 · 在桌面上看完整输出')
  })

  it('阴控:没被裁过的输出一个字都不加', () => {
    const out = toThreadMessages(
      [turn('t1', [toolItem('x1', 'ls', { outputText: '短输出' })])],
      { trimmedNote: note },
    )
    expect((out[0].content[0] as { result: string }).result).toBe('短输出')
  })

  it('没有输出、只裁了入参 ⇒ 那句话落在入参上(❌ 不凭空造一个 result)', () => {
    const out = toThreadMessages(
      [turn('t1', [toolItem('x1', 'write', { rawInput: '{"content":"前 8K', trimmedChars: 12 })])],
      { trimmedNote: note },
    )
    const part = out[0].content[0] as { result?: string; argsText: string }
    expect(part.result).toBeUndefined()
    expect(part.argsText).toContain('已截断 12 字')
  })
})

// 148 10-14(旁观的活画面,③)、owner 10-15:工具交回来的图,手机工具卡下也画。时间线里只有每张图的类型和字数
// (`imageRefs`,transport-trim),图走 assistant-ui 给界面留的 `artifact`,按 (条目, 第几张) 去机器上取;❌ 进 result 文字。
// 取到的图本身图格从时间线拿(toolImagesById),❌ 从 artifact 拿:assistant-ui 那一份比时间线晚一两次提交(10-16 复核)。
describe('工具交回来的图', () => {
  const appCheck = (extra: Record<string, unknown>) =>
    toolItem('c1', 'mcp__gugu__catalog_call', {
      kind: 'mcp-tool-call',
      server: 'gugu',
      tool: 'catalog_call',
      rawInput: JSON.stringify({ tool: 'app_check', args: { tab_kind: 'op-probe.main' } }),
      outputText: 'It loaded without errors.',
      ...extra,
    })

  it('按交回来的顺序,带上去取它要的条目和第几张、字数;名字说是哪次调用的第几张;❌ 带图本身(取到的也不带)', () => {
    const [message] = toThreadMessages([
      turn('t1', [appCheck({
        imageRefs: [{ mimeType: 'image/jpeg', chars: 30_000 }, { mimeType: 'image/png', chars: 25_000 }],
        images: [undefined, { mimeType: 'image/png', data: 'BBBB' }],
      })]),
    ])
    const part = message.content[0] as { artifact?: unknown; result: string }
    expect(part.artifact).toEqual({
      images: [
        { itemId: 'c1', index: 0, chars: 30_000, alt: 'app_check 1/2' },
        { itemId: 'c1', index: 1, chars: 25_000, alt: 'app_check 2/2' },
      ],
    })
    // 图不算被裁的字:结果文字照原样,不挂「已截断」。
    expect(part.result).toBe('It loaded without errors.')
  })

  it('阴控:没交图的调用没有 artifact', () => {
    const [message] = toThreadMessages([turn('t1', [appCheck({})])])
    expect(message.content[0]).not.toHaveProperty('artifact')
  })

  it('时间线手里的图按条目 id 交给图格:交回了图的条目都在(工具组里的子调用也算),还没取到的是空的;没交图的不在', () => {
    const shot = { mimeType: 'image/png', data: 'BBBB' }
    const byId = toolImagesById([
      turn('t1', [
        appCheck({ imageRefs: [{ mimeType: 'image/png', chars: 4 }, { mimeType: 'image/png', chars: 4 }], images: [undefined, shot] }),
        toolItem('group-1', '读图', { kind: 'tool-group', label: '读图', children: [toolItem('read-1', 'Read', { imageRefs: [{ mimeType: 'image/png', chars: 4 }], images: [shot] })] }),
        toolItem('read-2', 'Read', { imageRefs: [{ mimeType: 'image/png', chars: 4 }] }),
        toolItem('plain', 'Bash', { outputText: 'ok' }),
      ]),
    ])
    expect([...byId.keys()]).toEqual(['c1', 'read-1', 'read-2'])
    expect(byId.get('read-2')).toEqual([])
    expect(byId.get('c1')?.[1]).toBe(shot)
    expect(byId.get('c1')?.[0]).toBeUndefined()
    expect(byId.get('read-1')?.[0]).toBe(shot)
  })
})
