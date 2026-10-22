/**
 * 把桥折进正文里的「等级」还原回来 —— hook 说的话不是 agent 写的散文。
 *
 * # 这条通知在链路上被压扁了两次
 *
 * ① Claude 那侧本来是结构化的。`@anthropic-ai/claude-agent-sdk@0.3.197` 的
 *    `SDKInformationalMessage`：`{ type:'system', subtype:'informational', content, level }`，
 *    `level: 'info' | 'notice' | 'suggestion' | 'warning'`（文档原话：「'info' 只在
 *    transcript 模式出现；'notice' 以灰色呈现；'suggestion' 与 'warning' 更显眼」）。
 *    hook 的那一层再套一层：`<HookName> says: <行>`，**逐行**加前缀。
 * ② 到 ACP 就没地方放等级了。`@agentclientprotocol/claude-agent-acp@0.54.1` 的
 *    `acp-agent.js` 在 `case 'informational'` 里写得很直白：
 *
 *        // ACP's agent_message_chunk has no severity field, so fold the level into
 *        // the text for the more prominent levels ('info' is transcript-only noise
 *        // — leave plain).
 *        const text = message.level === 'info' ? message.content
 *          : `**${Level}:** ${message.content}`
 *
 *    然后当**普通助手消息**发出来。于是屏幕上出现一句 `**Notice:** Stop says: …`，
 *    读起来像 agent 自己写的一段加粗提示。
 *
 * ⇒ 这里读的不是「散文里出现了 Notice 这个词」，是一段**已知编码**的逆运算：同一个包、
 * 同一个钉死的版本写进去，我们照着读回来。⚠️ 升 `claude-agent-acp` 时要重核那段编码还在不在
 * —— 它一旦改了措辞，这里会静静地什么都不认（回退成原样的文本，不会假装认得）。
 *
 * # 为什么两道都要，缺一不可
 *
 * 只认 `**Warning:** ` 前缀会误伤：agent 自己完全写得出以加粗标题开头的一段话。
 * 只认 `X says: ` 也不行：那是 hook 那一层的格式，不带等级。**两道一起**才把误判压到
 * 「agent 恰好写了 `**Warning:** Foo says: …`」这种程度。代价是非 hook 的 informational
 * （斜杠命令输出之类）不被认出、照旧当正文渲染 —— 那正是保守的那一边。
 */

/** 桥会折进正文的三档。`info` 不折（本就该素面），所以这里读不到、也不该读到。 */
export type HookNoticeLevel = 'notice' | 'suggestion' | 'warning';

const LEVEL_BY_LABEL: Readonly<Record<string, HookNoticeLevel>> = {
  Notice: 'notice',
  Suggestion: 'suggestion',
  Warning: 'warning',
};

export interface HookNotice {
  level: HookNoticeLevel;
  /** 说话的那个 hook：`Stop` / `UserPromptSubmit` / …。 */
  hookName: string;
  /** 剥掉等级与 `X says:` 之后的正文。 */
  body: string;
}

/** `**Notice:** ` —— 桥拼的是 `level[0].toUpperCase() + level.slice(1)`，所以首字母大写、其余小写。 */
const LEVEL_PREFIX = /^\*\*([A-Z][a-z]+):\*\* /;

/**
 * `Stop says: ` / `PostToolUse says: ` / `SessionStart:compact says: `。
 *
 * ❌ 不写白名单：hook 事件名是上游的、会加（护栏常量会过期）。按**形状**认：
 * 一个或几个大驼峰词（可带 `:来源` 限定，压缩后的 SessionStart 就是 `SessionStart:compact`）+ ` says: `。
 */
const SPEAKER = /^((?:[A-Z][A-Za-z]*)(?: [A-Z][A-Za-z]*)*(?::[\w.*|-]+)?) says: /;

function speakerOf(line: string): string | null {
  return SPEAKER.exec(line)?.[1] ?? null;
}

/**
 * 同一句 hook 输出的第二种来路（#55）：桥声明了 `session.notices`（gugu #6596）之后，informational
 * 不再折进助手正文，而是一条 ACP `notice` —— 落成 `provider-notice`，`title` = 第一行，`detail` = 其余几行；
 * 第一行太长时 `title` 换成桥的通用标题、整段进 `detail`（`claude-agent-acp` `splitNoticeText`）。
 * 这条路上没有等级前缀，认的只是说话人那一层的形状。返回说话的 hook，不是 hook 就是 null。
 */
export function hookSpeakerOfNotice(notice: { title?: string; detail: string }): string | null {
  return speakerOf(notice.title ?? '') ?? speakerOf(notice.detail);
}

export function parseHookNotice(text: string): HookNotice | null {
  const levelMatch = LEVEL_PREFIX.exec(text);
  if (!levelMatch) return null;
  const level = LEVEL_BY_LABEL[levelMatch[1] as string];
  if (!level) return null;

  const lines = text.slice(levelMatch[0].length).split('\n');
  // 多行 hook 输出里只有第一行拿得到 `**Notice:** `（桥是先逐行加 `X says:`，再给整段加一次
  // 等级前缀），所以说话人要在**每一行**上都对得上、且是同一个 —— 不一致就说明这不是 hook 的
  // 那种消息，整条原样放回去。
  const speaker = speakerOf(lines[0] ?? '');
  if (speaker === null) return null;
  if (!lines.every((line) => speakerOf(line) === speaker)) return null;

  const strip = `${speaker} says: `.length;
  return { level, hookName: speaker, body: lines.map((line) => line.slice(strip)).join('\n') };
}
