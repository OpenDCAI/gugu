import { useMessagePartText } from '@assistant-ui/react'
import { Markdown } from '@/components/markdown/Markdown'

/**
 * 文本片段的渲染件。
 *
 * 官方那份自带一套 markdown 渲染（`@assistant-ui/react-markdown` + remark-gfm + 自己的代码块头），
 * 但咕咕已经有一套：统一的 `Markdown`（Streamdown —— markdown / 代码高亮 / GFM 表格 /
 * KaTeX），并且 tokens.css 专门为它铺了 shadcn 语义色的桥。
 *
 * owner 2026-09-05 定的口径是「ui 和通用对话的 ui 渲染对齐」，所以**正文用咕咕这套**，
 * 而外面的骨架、动效、间距全是官方的 —— 两条要求在这里同时成立，不是二选一。
 * 这也是唯一一处我们没照抄官方实现的片段渲染件，其余（工具卡、思考、建议、操作条）都是原件。
 */
export function MarkdownText() {
  const { text } = useMessagePartText()
  // 与桌面会话页转录同一种读法(`packages/session-chat-ui/src/core/markdown/to-html.ts` 的 TRANSCRIPT_DIALECT):
  // 段落里的单个换行就是换行。不开的话,agent 一行一句写的诗/清单在手机上并成一整段(2026-10-02 真机)。
  return <Markdown trust="chat" hardBreaks content={text} />
}
