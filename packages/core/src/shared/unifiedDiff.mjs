// @@@unified-diff —— 一段 unified diff 的 hunk 还原成改前/改后两份文本(ACP v1 的 diff 块)。全仓一份:
// Codex 的 fileChange(codex-app-server-acp.mjs)与 ACP v2 的 git patch(session-plugins acp-v2.ts)都从这里取。

/**
 * unified diff 的 hunk → 改前/改后两份文本;没有 hunk 返回 null。
 *
 * ⚠️ 多个 hunk 会被首尾相接:补丁里本来就没有 hunk 之间那段没改动的内容,拼起来等于把不相邻的
 * 几段呈现成相邻。展示出来的每一行都是真的,但「中间省略了多少」这个信息补丁没给,也补不出来。
 */
export function unifiedDiffTexts(patch) {
  const before = []
  const after = []
  let inHunk = false
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      before.push(text)
      after.push(text)
    }
  }
  if (!inHunk) return null
  return { oldText: withoutTrailingNewline(before.join('\n')), newText: withoutTrailingNewline(after.join('\n')) }
}

/**
 * 去掉结尾那一个换行。
 *
 * 文本文件本来就以换行收尾,但渲染侧按 `\n` 切行,留着它会凭空多出一个空行 —— 只写了一行 `one`
 * 的新建文件会显示成 `+2 −0`。这不是内容,是行尾约定。
 */
export function withoutTrailingNewline(text) {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}
