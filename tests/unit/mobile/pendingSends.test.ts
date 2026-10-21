import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { settlePendingSends, userMessageIds, type PendingSend } from '@/mobile/agent-watch/pending-sends'

/**
 * 手机上「已按发送、记录里还没回来」的那几句什么时候让位。
 * 失败模式两头都要钉:回显到了还不让位(同一句画两遍),没到就先让位(自己那句又从屏幕上消失)。
 */

function turn(id: string, items: TranscriptTurn['items']): TranscriptTurn {
  return { id, seq: 1, initiator: 'user', items } as TranscriptTurn
}
const user = (id: string, text: string) =>
  ({ kind: 'message', id, seq: 0, role: 'user', text }) as TranscriptTurn['items'][number]
const agent = (id: string, text: string) =>
  ({ kind: 'message', id, seq: 1, role: 'assistant', text }) as TranscriptTurn['items'][number]

const before = [turn('t1', [user('u1', '好'), agent('a1', '在的')])]
const pending = (id: string, text: string, accepted = true, turns = before): PendingSend => ({
  id,
  text,
  baseline: userMessageIds(turns),
  accepted,
})

describe('乐观发送的让位', () => {
  it('回显还没到 ⇒ 原样返回同一个数组(调用方据此不写 state)', () => {
    const list = [pending('p1', '继续')]
    expect(settlePendingSends(list, before)).toBe(list)
  })

  it('记录里出现了这一句 ⇒ 让位', () => {
    const after = [...before, turn('t2', [user('u2', '继续')])]
    expect(settlePendingSends([pending('p1', '继续')], after)).toEqual([])
  })

  it('发送之前就有的同一句不算回显(基线之内的不认)', () => {
    // 上一轮也说过「好」:那一行在基线里,❌ 拿它顶掉这次的「好」。
    expect(settlePendingSends([pending('p1', '好')], before).map((p) => p.id)).toEqual(['p1'])
  })

  it('还没受理时,新冒出来的别处消息不认领;受理后按先后认领一条', () => {
    const after = [...before, turn('t2', [user('u2', '桌面那头发的')])]
    expect(settlePendingSends([pending('p1', '继续', false)], after).map((p) => p.id)).toEqual(['p1'])
    expect(settlePendingSends([pending('p1', '继续', true)], after)).toEqual([])
  })

  it('按先后认领是独占的:一条记录只顶一句', () => {
    const after = [...before, turn('t2', [user('u2', 'a &amp; b')])]
    const out = settlePendingSends([pending('p1', 'a & b'), pending('p2', 'c < d')], after)
    expect(out.map((p) => p.id)).toEqual(['p2'])
  })

  it('几句被并成一行 ⇒ 一行把几句都认走', () => {
    const after = [...before, turn('t2', [user('u2', '第一句\n\n第二句')])]
    expect(settlePendingSends([pending('p1', '第一句'), pending('p2', '第二句')], after)).toEqual([])
  })

  it('连发两句一样的,只回来一句 ⇒ 只让一句', () => {
    const after = [...before, turn('t2', [user('u2', '继续')])]
    const out = settlePendingSends([pending('p1', '继续'), pending('p2', '继续')], after)
    expect(out.map((p) => p.id)).toEqual(['p2'])
  })

  it('往上翻出来的更早历史不算回显 —— 它们不在基线里,但排在基线前面', () => {
    // 发送之后往上翻:loadOlder 在前面插进一整轮,基线里没有它的 id。
    const older = [turn('t0', [user('u0', '更早的一句'), agent('a0', '嗯')]), ...before]
    expect(settlePendingSends([pending('p1', '继续', true)], older).map((p) => p.id)).toEqual(['p1'])
  })

  it('更早历史里恰好有同一句短话,也不许把这一句认走', () => {
    const older = [turn('t0', [user('u0', '继续')]), ...before]
    expect(settlePendingSends([pending('p1', '继续', false)], older).map((p) => p.id)).toEqual(['p1'])
    // 阳控:同一句真从后面回来了,照样让位。
    expect(settlePendingSends([pending('p1', '继续', false)], [...older, turn('t2', [user('u2', '继续')])])).toEqual([])
  })

  it('还没受理时不按「包含」认:别处发来的「好的呀」不能把手机这句「好」认走', () => {
    const after = [...before, turn('t2', [user('u2', '好的呀')])]
    expect(settlePendingSends([pending('p1', '好', false)], after).map((p) => p.id)).toEqual(['p1'])
    // 阳控:受理之后同一行照样认(并成一行的那种回显就是这个形状)。
    expect(settlePendingSends([pending('p1', '好', true)], after)).toEqual([])
  })

  it('按先后认领不认咕咕投递:投递和这一句前后脚到,这一句照样留在屏上,直到它自己那一行回来', () => {
    const delivery = [
      '<gugu_delivery route="chat" from="Alice" from_id="user:a" chat="208911" chat_kind="group" msg="msg:1">',
      '<![CDATA[群里的一句]]>',
      '</gugu_delivery>',
    ].join('\n')
    const withDelivery = [...before, turn('t2', [user('u2', delivery)])]
    expect(settlePendingSends([pending('p1', '手机这句')], withDelivery).map((p) => p.id)).toEqual(['p1'])
    expect(settlePendingSends([pending('p1', '手机这句')], [...withDelivery, turn('t3', [user('u3', '手机这句')])])).toEqual([])
    // 阳控:同一位置换成不是投递的一行,照旧按先后认走。
    expect(settlePendingSends([pending('p1', '手机这句')], [...before, turn('t2', [user('u2', '别的写法')])])).toEqual([])
  })

  it('「好」与「好的」都在路上,「好的」先回来 ⇒ 只让「好的」', () => {
    const after = [...before, turn('t2', [user('u2', '好的')])]
    const out = settlePendingSends([pending('p1', '好'), pending('p2', '好的')], after)
    expect(out.map((p) => p.id)).toEqual(['p1'])
  })

  it('空白差异不影响认领(折行 / 首尾空白)', () => {
    const after = [...before, turn('t2', [user('u2', '  第一行\n第二行 ')])]
    expect(settlePendingSends([pending('p1', '第一行 第二行', false)], after)).toEqual([])
  })

  it('agent 忙、那台机器把这句排进队列 ⇒ 乐观那一句让位给排着的那一句,屏上只有一份', () => {
    expect(settlePendingSends([pending('p1', '继续')], before, [{ id: 'qp-1', text: '继续' }])).toEqual([])
    // 还没受理时也认:队列里出现的就是这一句原文。
    expect(settlePendingSends([pending('p1', '继续', false)], before, [{ id: 'qp-1', text: '继续' }])).toEqual([])
  })

  it('发送之前就排着的同一句不算回显(在基线里)', () => {
    const queued = [{ id: 'qp-0', text: '继续' }]
    const send: PendingSend = { id: 'p1', text: '继续', baseline: userMessageIds(before, queued), accepted: true }
    expect(settlePendingSends([send], before, queued).map((p) => p.id)).toEqual(['p1'])
  })
})
