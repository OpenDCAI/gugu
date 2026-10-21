// 「添加上下文」搜索框里敲的一句话 → 一条新提示词。
//
// owner 2026-09-10 定的交互:那个框既是搜索也是新建 —— 打的字能匹配上现有条目就回车选它,
// 一条都匹配不上,列表位置就变成一行「新建」的预览,回车即建立并塞进输入框。
// 行本身长得就是「标题 + 正文」两段,所以输入也用同一个形状:`标题: 正文`。
//
// 不写冒号 = 整句既是标题也是正文。这不是偷懒的回落,而是让「打什么就插入什么」这条永远成立:
// ❌ 别自作主张把标题截短成摘要 —— 用户看到的预览和真正插进输入框的文本必须是同一份。
export interface PromptDraft {
  title: string;
  prompt: string;
}

/** 半角与全角冒号都算分隔符;取**第一个**,因为正文里出现冒号是常态。 */
const SEPARATOR = /[:：]/;

export function parsePromptDraft(input: string): PromptDraft | null {
  const text = input.trim();
  if (!text) return null;

  const match = SEPARATOR.exec(text);
  if (!match) return { title: text, prompt: text };

  const title = text.slice(0, match.index).trim();
  const prompt = text.slice(match.index + match[0].length).trim();
  // 冒号在头(「: 正文」)或在尾(「标题:」)都缺了一半 —— 这时它不是分隔符,整句照旧当一条。
  if (!title || !prompt) return { title: text, prompt: text };
  return { title, prompt };
}
