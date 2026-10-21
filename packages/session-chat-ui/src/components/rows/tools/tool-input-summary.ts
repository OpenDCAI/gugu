/**
 * 供应商没给 `inputSummary` 时,从 `rawInput` 现推一行摘要放到行上。
 *
 * 为什么需要它:ACP 的 `kind` 枚举只有 8 个值,而 Claude Code 那一侧绝大多数工具
 * (`Skill`、`EnterPlanMode`、所有 `mcp__*`)都不在其中 ⇒ 一律落进 `unknown-tool-call`,
 * 行上就只剩一个原始函数名。参数并没有丢 —— 真机上量过,18 行工具展开后 14 行都带着
 * 干净的 `rawInput`(`{"url":"http://127.0.0.1:8000/index.html"}`)—— 只是全被藏在
 * 一次点击之后。execute 那条的毛病是「太裸」,这一批正相反,是「太藏」。
 *
 * 改在这个兜底格上,而不是给每种工具各写一遍:后者正是 #4981 一开始犯的错
 * (把 `tool-call` 这个**概念**对到了文件名叫 `tool` 的那**一个**行族上)。
 * 兜底格修好了,将来新出现的工具自动受益,不必再有人记得来加一遍。
 *
 * ❌ 不替代 `inputSummary`:供应商自己说的话永远优先,这里只在它没说时补位。
 */

/** 片是预览,不是全文;全文在展开后的 request 面板里一字不差。 */
const MAX_CHARS = 200;

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * 一个值渲染成一小段。数组和对象**不展开**,只说它有多大 —— 把一整棵 JSON 树摊平
 * 塞进一行,读者既读不完也读不懂,而那正是「参数裸露」的另一种写法。
 */
function render(value: unknown): string {
  const s = scalar(value);
  // 折叠只作用在**值**上,不作用在拼好的整串上 —— 否则用作分隔的双空格会被自己吃掉,
  // `level: error  all: true` 塌成 `level: error all: true`,读者分不清哪儿断开。
  if (s !== null) return s.replace(/\s+/g, ' ').trim();
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return '{…}';
  return String(value);
}

export function deriveToolInputSummary(rawInput: string | undefined): string | undefined {
  if (!rawInput) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    // 不是 JSON 就照原样当一行文本用 —— 供应商爱怎么序列化是它的事,
    // 读者要的是「这次调用带了什么」,原文比一句「无法解析」有用。
    const text = rawInput.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, MAX_CHARS) : undefined;
  }

  const one = scalar(parsed);
  if (one !== null) return render(parsed).slice(0, MAX_CHARS) || undefined;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  // 只有一个参数时省掉键名:`{"url":"…"}` 读者要的是那个网址,不是「url」两个字母。
  if (entries.length === 1) {
    const text = render(entries[0][1]);
    return text ? text.slice(0, MAX_CHARS) : undefined;
  }

  const text = entries.map(([key, value]) => `${key}: ${render(value)}`).join('  ');
  return text ? text.slice(0, MAX_CHARS) : undefined;
}
