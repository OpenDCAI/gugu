// @@@reasoning-text (#6830) —— Codex 的一段思考画哪份文本,全仓只有这一份判据:会话页记录源(rollout 文件)与
// 桌面适配器(app-server 条目)各自把自己的格式归一成两组纯文本,再从这里取。❌ 别在别处再挑一次。
// - 有摘要画摘要:OpenAI 家的原文只落密文,摘要才是给人看的那份。
// - 没有摘要画原文:GLM 这类只写原文(rollout 的 `reasoning_text`)、摘要为空。
// - 密文从不进这两组。
// - 每段各是一节(摘要一节以加粗小标题开头),节与节之间空一行。

/** 要画的文本;两组都没有字 → null(这一段不画)。 */
export function codexReasoningText(summary, raw) {
  const texts = (parts) => parts.filter((part) => typeof part === 'string' && part.trim().length > 0)
  const summaryTexts = texts(summary)
  const shown = summaryTexts.length > 0 ? summaryTexts : texts(raw)
  return shown.length > 0 ? shown.join('\n\n') : null
}
