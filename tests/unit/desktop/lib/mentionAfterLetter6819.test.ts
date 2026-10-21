// #6819 「@名字」算不算提及 —— 同一张边界表,五个读方必须给出同一个答案:
// 发送路由(resolveMentionUserIds)、正文高亮(findInjectableMentionSpans)、agent 信封(buildAgentMentionContext)、
// IM server 核 @ 与收件人(reconcileMentionExpression)、输入框候选(findMentionStart + isMentionQueryActive)。
// 规则:@ 前面不看;名字后面接字母/数字/下划线,或接「. + ASCII 字母数字」(域名尾巴)不算;重叠取最长。
import { describe, expect, it } from 'vitest'
import { resolveMentionUserIds, type MentionCandidate } from '../../../../apps/desktop/src/lib/mention'
import { findInjectableMentionSpans } from '../../../../apps/desktop/src/lib/mentionMdast'
import { findMentionStart, isMentionQueryActive } from '../../../../apps/desktop/src/lib/mentionMatch'
import { buildAgentMentionContext, type GuguIdentity } from '../../../../packages/core/src/local/agent/deliveryEnvelope'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用(同 guguImMcp.test.ts)。
import { reconcileMentionExpression } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const NAMES = ['Alice', 'gmail', '张三', '张三丰', 'Claude', 'Claude 2', 'Claude 84']
const members: MentionCandidate[] = NAMES.map((name, i) => ({ id: `u${i}`, name, type: i % 2 ? 'agent' : 'human' }))
const idOf = new Map(members.map((m) => [m.id, m.name]))
const identities = new Map<string, GuguIdentity>(members.map((m) => [m.id, { guguNumber: null, displayName: m.name, isAgent: m.type === 'agent' }]))

const TABLE: Array<[text: string, mentioned: string[]]> = [
  ['……没有显示running detail@Claude 84 看一下什么情况', ['Claude 84']],
  ['alice@gmail.com', []],
  ['alice@gmail', ['gmail']],
  ['foo@Alice.', ['Alice']],
  ['foo@Alice。', ['Alice']],
  ['@Alice, 看下', ['Alice']],
  ['@Alice.com', []],
  ['@Alice.bob 呢', []],
  ['@张三丰 来一下', ['张三丰']],
  ['你好@张三', ['张三']],
  ['@Claude 2 看看', ['Claude 2']],
  ['@Alicex 不是名字', []],
  ['博客 medium.example/@Alice 这篇', ['Alice']],
]

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()

describe('#6819 @ mention boundary is one rule for every reader', () => {
  it.each(TABLE)('send routing: %s', (text, mentioned) => {
    expect(sorted(resolveMentionUserIds(text, [], members, true).map((id) => idOf.get(id)!))).toEqual(sorted(mentioned))
  })

  it.each(TABLE)('body highlight: %s', (text, mentioned) => {
    expect(sorted(findInjectableMentionSpans(text, NAMES).map((s) => s.name))).toEqual(sorted(mentioned))
  })

  it.each(TABLE)('agent envelope message_context: %s', (text, mentioned) => {
    const context = buildAgentMentionContext(text, members.map((m) => m.id), identities, 'reader') ?? ''
    expect(sorted([...context.matchAll(/^"@(.+?)" = /gm)].map((m) => m[1]!))).toEqual(sorted(mentioned))
  })

  it.each(TABLE)('IM server @ vs recipients: %s', (text, mentioned) => {
    const rows = members.map((m) => ({ id: m.id, display_name: m.name }))
    expect(sorted(reconcileMentionExpression(rows, text, []).mismatches)).toEqual(sorted(mentioned))
  })

  it('@all follows the same rule on both sides', () => {
    const everyone: MentionCandidate[] = [...members, { id: 'all', name: '所有人', type: 'all' }]
    expect(resolveMentionUserIds('hello@所有人 开会', [], everyone, true)).toContain('*')
    expect(resolveMentionUserIds('x@所有人.com', [], everyone, true)).not.toContain('*')
    const rows = members.map((m) => ({ id: m.id, display_name: m.name }))
    expect(reconcileMentionExpression(rows, 'hello@all 开会', ['*']).content).toBe('hello@all 开会')
    expect(reconcileMentionExpression(rows, 'x@all.com', ['*']).content).toBe('@all x@all.com')
  })

  it('the composer offers candidates right after a letter, and lets go once the query is a domain', () => {
    const typed = 'running detail@Cl'
    const start = findMentionStart(typed, typed.length)
    expect(start).toBe(typed.indexOf('@'))
    expect(isMentionQueryActive(typed.slice(start! + 1), members)).toBe(true)
    expect(isMentionQueryActive('gmail.com', members)).toBe(false)
  })
})
