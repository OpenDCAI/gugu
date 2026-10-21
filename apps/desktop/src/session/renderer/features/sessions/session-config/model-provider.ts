/**
 * 模型 → **厂商**(provider)。
 *
 * 上游那版模型选择器(assistant-ui `model-selector`,「With search, provider filters + groups」)
 * 的一级分类**就是厂商**:药丸是厂商名(OpenAI / Google / xAI / DeepSeek / Groq)、组头是厂商名、
 * 每一行左边是厂商 logo。咕咕这边比它多一根轴 ——「这条是你自己的,还是咕咕代付的」——
 * 那根轴是**二级**分类,挂在组头厂商名的后面,不与厂商争一级的位置(owner 2026-09-05)。
 *
 * ## 判据只能是模型自己的 id / 名字
 *
 * ⚠️ ❌ 不许从 `PlatformModelOption.protocol` 推厂商:那个字段说的是「用哪套 HTTP 形状说话」。
 * 实测 `glm-5.2` 的 protocol 是 `anthropic-messages` —— 按协议推它会被划进 Anthropic,
 * 而它是智谱的模型。协议是传输层的事,与谁造了这个模型无关。
 *
 * ⚠️ ❌ 也不从 harness(agent)推:一家 harness 可以跑别家的模型 —— 咕咕平台模型正是这么用的
 * (Codex 这个壳跑 GLM)。按壳推会把整段咕咕模型全标成 OpenAI。
 *
 * ## 认不出来就是认不出来
 *
 * 匹配不上返回 `null`,调用方于是不画图标、组头退回二级分类那句话。
 * ❌ 不设「其它」这一档兜底 —— 那会造出一枚点了等于没筛的药丸,
 * 也会让一个新厂商的模型看起来像是被正确归类了。fail loud 的界面形态就是**留白**。
 */

/**
 * 一家厂商。`iconKey` 对应 `session/assets/images/<key>.svg`,**必填**。
 *
 * ⚠️ 它曾是可选的(「取不到图标的厂商留空」),结果 MiniMax 就那么空着上了线 ——
 * 列表里别家都有 logo,它那一行左边是个洞。owner 2026-09-18 指出来的。
 * 缺图标不是「优雅降级」,是没做完:厂商进了这张表就得配一枚图标。
 */
export interface ModelProvider {
  id: string;
  /** 界面上的显示名 —— 专有名词,不进 i18n(上游那排药丸也是 OpenAI / Google 原样)。 */
  name: string;
  iconKey: string;
}

interface ProviderRule extends ModelProvider {
  /** 对 `${id} ${displayName}` 的小写形式匹配。 */
  match: RegExp;
}

/**
 * 顺序即优先级,第一条命中的赢。
 *
 * ## 词根的收尾一律用 `(?![a-z])`,❌ 不用 `\b`
 *
 * `\b` 是「单词字符与非单词字符之间」,而**数字也是单词字符** —— 所以 `\bqwen\b`
 * 认不出 `qwen3.8-max-0902`(`qwen` 与 `3` 之间没有边界)。2026-09-18 线上就是这么坏的:
 * Qwen 那一家整个从选择器里消失了,连药丸都没有,而测试是绿的 ——
 * 因为测试的样本写的是 `qwen-3-max`(带连字符),不是目录里真实的那个 id。
 *
 * `(?![a-z])` 表达的才是我们要的意思:词根后面**不能再接字母**,
 * 但接数字(`qwen3`)、连字符(`glm-5.3`)、点、或到头都算命中。
 * 它同时保留了防误伤的能力 —— `qwenish` 仍然不命中。
 *
 * ⚠️ 新增一家时先想「它的词根会不会出现在别家的模型名里」——
 * 例如 `max` ❌ 不能当 MiniMax 的词根(`qwen3.8-max` 会被吃掉)。
 */
const PROVIDER_RULES: readonly ProviderRule[] = [
  { id: 'openai', name: 'OpenAI', iconKey: 'openai', match: /\b(gpt|codex|o[134])(?![a-z])/ },
  {
    id: 'anthropic',
    name: 'Anthropic',
    iconKey: 'claude',
    match: /\b(claude|opus|sonnet|haiku)(?![a-z])/,
  },
  { id: 'google', name: 'Google', iconKey: 'gemini', match: /\b(gemini|gemma)(?![a-z])/ },
  { id: 'xai', name: 'xAI', iconKey: 'xai', match: /\bgrok(?![a-z])/ },
  { id: 'zhipu', name: '智谱', iconKey: 'zhipu', match: /\b(glm|chatglm|zhipu)(?![a-z])/ },
  { id: 'deepseek', name: 'DeepSeek', iconKey: 'deepseek', match: /\bdeepseek(?![a-z])/ },
  { id: 'qwen', name: 'Qwen', iconKey: 'qwen', match: /\b(qwen|qwq|tongyi)(?![a-z])/ },
  { id: 'moonshot', name: 'Kimi', iconKey: 'kimi', match: /\b(kimi|moonshot)(?![a-z])/ },
  {
    id: 'mistral',
    name: 'Mistral',
    iconKey: 'mistral',
    match: /\b(mistral|magistral|devstral|codestral|ministral)(?![a-z])/,
  },
  { id: 'minimax', name: 'MiniMax', iconKey: 'minimax', match: /\bminimax(?![a-z])/ },
];

/**
 * 认这条模型是哪家的。认不出 → `null`(见抬头:❌ 不兜底成「其它」)。
 *
 * `-` 与 `.` 在正则里不是词边界的一侧,所以 `glm-5.2` 里 `\bglm\b` 是能命中的
 * (`m` 与 `-` 之间就是边界);写成 `\bglm-` 的那一支是给 `glm5` 这类没有分隔符的写法留的。
 */
export function resolveModelProvider(modelId: string, displayName?: string): ModelProvider | null {
  const haystack = `${modelId} ${displayName ?? ''}`.toLowerCase();
  for (const rule of PROVIDER_RULES) {
    if (rule.match.test(haystack)) {
      const { match: _match, ...provider } = rule;
      return provider;
    }
  }
  return null;
}

/** 供测试与守卫用的全集(❌ 别在产品代码里遍历它 —— 清单是模型决定的,不是厂商表决定的)。 */
export const MODEL_PROVIDERS: readonly ModelProvider[] = PROVIDER_RULES.map(
  ({ match: _match, ...provider }) => provider,
);

export const MODEL_PROVIDER_IDS: readonly string[] = MODEL_PROVIDERS.map((p) => p.id);
