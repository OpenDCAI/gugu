// ACP 的 prompt 块 → codex app-server 的 input items。
//
// ⚠️ 这一格曾经把**非文本的块整条丢掉**:`session/prompt` 只取 text 拼成一条,图片块既没有
// `text` 也没有 `uri`,于是映射成空串被过滤掉 —— 输入框上有 chip、消息发得出去、模型却说
// 「我看不到图片」(owner 2026-09-09 实撞;那一轮的读数是:渲染层确实带着 attachment ref 发出,
// runtime 也把它取成了 image 块,断点就在这里)。
//
// 形状取自 codex app-server 自己的用户输入项:`text` / `image`(带 `url`,可以是 data URL)/
// `localImage`(带 `path`)。上游 `@agentclientprotocol/codex-acp` 同协议同写法,可对照。
//
// 单独成文件是为了让它可被判据钉住:适配器本体是一个启动即校验环境变量的可执行脚本,
// import 不进测试进程。判据在 `codex-app-server-prompt.test.ts`。

/** 连续的文本块合成一条 —— 与旧写法的连接方式保持一致(重放侧也复用它)。 */
export function joinPromptText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((entry) => (entry?.type === 'text' ? String(entry.text ?? '') : entry?.uri ? String(entry.uri) : ''))
    .filter(Boolean)
    .join('\n')
}

function imageUrl(block) {
  const data = typeof block?.data === 'string' ? block.data : ''
  const mimeType = typeof block?.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/png'
  if (data) return `data:${mimeType};base64,${data}`
  const uri = typeof block?.uri === 'string' ? block.uri : ''
  return uri || null
}

/**
 * 按 ACP 给的**顺序**映射,❌ 不重排:调用方已经决定过顺序(斜杠命令必须是第一块,
 * 会话级上下文在最前),这里再排一次就会把那条约定推翻。
 * 相邻的文本块合成一条,所以「没有图片」的那条老路径产出与从前逐字节相同。
 */
export function promptInputItems(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : []
  const items = []
  let textRun = []
  const flushText = () => {
    if (textRun.length === 0) return
    const text = joinPromptText(textRun)
    textRun = []
    if (text) items.push({ type: 'text', text, text_elements: [] })
  }
  for (const block of blocks) {
    if (block?.type === 'image') {
      const url = imageUrl(block)
      if (!url) continue
      flushText()
      items.push({ type: 'image', url })
      continue
    }
    textRun.push(block)
  }
  flushText()
  return items
}
