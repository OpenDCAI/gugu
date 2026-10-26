import { describe, expect, it } from 'vitest'
import { memoryContentPreview } from '../../../../apps/desktop/src/session/renderer/features/assistant/memory-content-preview'
import { parseMemoryNote } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'

describe('memory content previews', () => {
  it('uses body facts and ignores the agent index description', () => {
    const note = parseMemoryNote('owner-profile.md', '---\ndescription: only for agent retrieval\ntype: user\n---\n# About you\n## Facts\n- **Name:** Lin\n- Studies [robotics](https://example.test/research).')
    expect(memoryContentPreview(note.body)).toBe('Name: Lin Studies robotics.')
    expect(note.description).toBe('only for agent retrieval')
  })
  it('removes list, task, quote and inline formatting while preserving readable content', () => {
    expect(memoryContentPreview('1. **博士在读**\n2. 常用 `Python`\n\n> 喜欢简短说明\n\n- [x] 使用 _咕咕_')).toBe('博士在读 常用 Python 喜欢简短说明 使用 咕咕')
  })
  it('skips heading-only bodies, fenced code, comments, images and link definitions', () => {
    expect(memoryContentPreview('# Title\n\nSection\n---\n\n```txt\nprivate implementation\n```\n\n<!-- internal comment -->\n\n![avatar](image.png)\n\n[ref]: https://example.test')).toBe('')
  })
  it('keeps reference-link labels and table content without Markdown symbols', () => {
    expect(memoryContentPreview('[阅读资料][book]\n\n[book]: https://example.test\n\n| 项目 | 状态 |\n| --- | --- |\n| 研究 | 进行中 |')).toBe('阅读资料 项目 · 状态 研究 · 进行中')
  })
  it('takes only the first four content blocks after headings', () => {
    expect(memoryContentPreview('# Facts\n- 第一条\n- 第二条\n- 第三条\n- 第四条\n- 第五条')).toBe('第一条 第二条 第三条 第四条')
  })
  it('bounds the excerpt without cutting an emoji in half', () => {
    expect(memoryContentPreview('你好😀朋友再见', 6)).toBe('你好😀朋友…')
  })
})
