import { describe, expect, it } from 'vitest'
import { appendDraft } from '../../../../apps/desktop/src/lib/assistantDraft'

// #7199 按钮交来的那句话接在人已经打的字后面,❌ 盖掉。
describe('appendDraft', () => {
  it('输入框空着(或只有空白)= 这句话本身', () => {
    expect(appendDraft('', '关于「早报」：')).toBe('关于「早报」：')
    expect(appendDraft('  \n', '关于「早报」：')).toBe('关于「早报」：')
  })
  it('已经写了字:另起一行接在后面,写的不丢', () => {
    expect(appendDraft('帮我看看这个 \n', '关于「早报」：')).toBe('帮我看看这个\n关于「早报」：')
  })
})
