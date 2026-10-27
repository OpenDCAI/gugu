// The chat list row showed an assistant reply's raw Markdown (`**10/27 全天复盘** **凌晨…`); previews are plain text.
// Inline code stays literal (taskMentionRouting.test.ts holds the same contract for references inside code).
import { describe, expect, it } from 'vitest'
import { chatPreviewText } from '../../../../apps/desktop/src/lib/agentTurnFailure'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'

describe('markdownPlainText', () => {
  it.each([
    ['**10/27 全天复盘** **凌晨 02:46-0', '10/27 全天复盘 凌晨 02:46-0'],
    ['**阳台养花十五条** 1. **先看朝向', '阳台养花十五条 1. 先看朝向'],
    ['## 标题\n- 一\n- 二', '标题 一 二'],
    ['> 引用\n1. 第一条', '引用 第一条'],
    ['see [docs](https://example.com) ok', 'see docs ok'],
    ['*斜体* 和 _强调_ 和 ~~删除~~', '斜体 和 强调 和 删除'],
  ])('strips formatting from %j', (input, plain) => {
    expect(markdownPlainText(input)).toBe(plain)
  })

  it('drops a marker whose partner was cut off by the preview length limit', () => {
    expect(markdownPlainText('今天做成的 **钉钉授')).toBe('今天做成的 钉钉授')
  })

  it.each([
    '今晚北京晴，夜里降到 6.9℃，出门披件外套。',
    'snake_case_name and a*b*c',
    '3 * 4 = 12',
    'run `pnpm dev` now',
    'not `**bold** [x](y)` here',
  ])('leaves text that is not formatting alone, inline code included: %j', (input) => {
    expect(markdownPlainText(input)).toBe(input)
  })
})

describe('chatPreviewText', () => {
  it('shows the last message as plain text', () => {
    expect(chatPreviewText({ last_message_preview: '**晚报 · 10/27** **今天做成的**', last_message_failure: null })).toBe('晚报 · 10/27 今天做成的')
  })
})
