/**
 * 一段思考的**要旨**，做成行上那颗片（#4981 #7）。
 *
 * owner 验收截图（2026-09-05）里连着三行「短暂思考 ›」，每一行四个字，谁也不说自己想了
 * 什么 —— 他的原话是「这个短暂思考又是啥」。行本身没错（思考不到 1 秒就是这句），错在
 * 它**哑**：读者要一行一行点开才知道哪一行值得点开，于是三行都不点，三行都成了噪声。
 *
 * 上游 `elements-tool-timeline` 的一步是 `{ verb, chip }` —— 它示例里的思考那一步写作
 * `Thinking · planning the change`：动词交代这是哪一类动作，片交代这一次具体在做什么。
 * 这里补的正是那个片，与 tool / execute 行戴的是同一颗（`summaryChip`）。
 *
 * ⚠️ 取**第一行**，不是前 N 个字符：思考文本几乎都以一句自述开头（模型常写成
 * `**Deciding the layout**` 这样的小标题），第一行就是作者自己写的摘要。按字符截会把
 * 一句话拦腰砍断，反而更难读。
 *
 * ❌ 不总结、不改写：片是原文的**预览**，不是二次创作 —— 与 `deriveToolInputSummary`
 * 同一条规矩，全文永远在展开后的那一片里一字不差。
 */

/** 片是预览；真正的视觉截断由 `summaryChip` 的省略号做，这里只挡住病态长的一行。 */
const MAX_CHARS = 120;

/** 行首的块级记号：标题 / 列表 / 引用 / 分隔线残留。 */
const LEADING_MARKS = /^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)/;

/**
 * 行内强调记号。只脱**成对**的记号，单个星号（`2 * 3`）原样留着 —— 它不是记号，
 * 是内容。
 */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, '$1')
    .replace(/`([^`]+?)`/g, '$1');
}

export function thinkingSummary(text: string | undefined): string | undefined {
  if (!text) return undefined;

  for (const raw of text.split('\n')) {
    // 空行与纯记号行（`---`、`**` 之类）跳过：它们不是这段思考的第一句话。
    const line = stripEmphasis(raw.replace(LEADING_MARKS, '')).trim();
    if (line === '') continue;
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    return line.slice(0, MAX_CHARS);
  }
  return undefined;
}
