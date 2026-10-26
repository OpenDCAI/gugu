/** Owner-visible projection only. The durable message and model input retain host context. */
export function taskProtocolText(content: string): string {
  let text = content.trimEnd()
  const protocol = /(?:^|\n)<(gugu_work(?:_result)?|gugu_task_context)>\s*\n?[\s\S]*?\n?<\/\1>\s*$/
  for (let block = protocol.exec(text); block; block = protocol.exec(text)) text = text.slice(0, block.index).trimEnd()
  // Already-delivered work orders used an unwrapped, recognizable host suffix.
  // Restrict legacy removal to that suffix, never inline mentions or fenced examples.
  const legacy = /(?:^|\n)# (?:任务执行约定|Task Agent 执行约定)\r?\n- 你(?:是执行者|在完成一项任务)[^]*$/
  const match = legacy.exec(text)
  if (match && !text.slice(match.index).includes('```')) text = text.slice(0, match.index).trimEnd()
  return text
}
