// @@@1379 thread bootstrap — 把某 thread 的历史消息拼成「首进 thread 隔离 session」的上下文 seed。
// 纯函数、无依赖、可单测；接线在 deviceCommandRuntime（slice C）。
//
// 现状 gap：群 thread = 隔离 ACP session（#966），但新 thread session 是「冷」的——agent 拿不到该
// thread 前情。本模块把 get_thread_messages 拉来的历史拼成一个 <thread_context> 块，首进时 prepend
// 进 deliver 文本，让 agent 先读到前情、只回应新消息。

export interface ThreadMessageRow {
  senderUserId: string
  content: string
  createdAt: string
}

export interface ThreadBootstrapOptions {
  // 本 agent 的 gugu_user_id —— 历史里自己说过的话标注成「你」，避免 agent 误以为是别人。
  selfAgentUserId: string
  // 可选：把 sender_user_id 解析成可读名（咕咕号/昵称）。缺省直接用 id。
  labelFor?: (senderUserId: string) => string
  // 上下文字符上限（防超长撑爆窗口）；从**最新**端保留。默认 4000。
  maxChars?: number
}

function hhmm(iso: string): string {
  // 取 HH:mm（容错：非法时间 → 空）。
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 16)
}

function oneLine(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

// 把 thread 历史（时间正序）拼成 instruction 内文。空历史 → null（真「无前情」，调用方不注入，非错误）。
export function buildThreadBootstrapBody(
  rows: ThreadMessageRow[],
  opts: ThreadBootstrapOptions,
): string | null {
  const usable = rows.filter((r) => oneLine(r.content).length > 0)
  if (usable.length === 0) return null
  const maxChars = opts.maxChars ?? 4000
  const label = (id: string) => (id === opts.selfAgentUserId ? '你(本 agent)' : opts.labelFor?.(id) ?? id)
  const lines = usable.map((r) => {
    const t = hhmm(r.createdAt)
    return `${t ? `[${t}] ` : ''}${label(r.senderUserId)}: ${oneLine(r.content)}`
  })
  // 超长时从**最新**端保留（丢最旧的几行），thread 前情近的更相关。
  let kept = lines
  while (kept.length > 1 && kept.join('\n').length > maxChars) kept = kept.slice(1)
  const body = kept.join('\n')
  return (
    `本话题(thread)在你加入前的历史消息（供你了解前情；不要重复回应这些历史消息，只回应下面的新消息）：\n` +
    `${body}\n` +
    // @@@1887 — 话题 session 与主线隔离,agent 常误以为「看不到的历史=不存在」。指点它用已有的
    // gugu_message history/search 按需检索（history 不带 thread_root_id 即主线）,不注入主线快照。
    `（本话题只是会话的一个分支。若被问到本话题之外的既往交流,用 message_history——` +
    `不带 thread_root_id 即主线历史——或 message_search 查询,不要凭话题内可见内容断言「没聊过」。）\n`
  )
}
