import { describe, expect, it } from 'vitest'

import { isGuguSilence, NO_REPLY_MARKER } from '../../../../packages/core/src/local/agent/silenceMarker'

describe('isGuguSilence:只由标记和空白组成 = 不回', () => {
  it.each([
    NO_REPLY_MARKER,
    `\`${NO_REPLY_MARKER}\``,
    '[NO_REPLY][NO_REPLY]',
    ' [NO_REPLY]\n',
    '[NO_REPLY]\n\n[NO_REPLY]',
    '`[NO_REPLY]` [NO_REPLY]',
  ])('%j 是沉默', (text) => {
    expect(isGuguSilence(text)).toBe(true)
  })

  it.each([
    '',
    '   \n',
    '[NO_REPLY] 不过补充一句:日志在 logs/ 里',
    '收到。[NO_REPLY]',
    '[NO_REPLY',
    'NO_REPLY',
  ])('%j 不是沉默(照常上屏)', (text) => {
    expect(isGuguSilence(text)).toBe(false)
  })

  it('流式时标记的前缀也算沉默,标记后面跟着正文就不算', () => {
    expect(isGuguSilence('[NO_RE', { streaming: true })).toBe(true)
    expect(isGuguSilence('[NO_REPLY][NO_', { streaming: true })).toBe(true)
    expect(isGuguSilence('[NO_REPLY] 不过', { streaming: true })).toBe(false)
    expect(isGuguSilence('[NO_RE')).toBe(false)
  })
})
