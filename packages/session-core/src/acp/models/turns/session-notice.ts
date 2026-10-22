import { z } from 'zod';

/**
 * 这条会话遇到的一件事，画成转录里的一行（spec `session-always-openable`）。
 *
 * # 为什么是一行，而不是一张错误页
 *
 * owner 2026-09-19 的裁决：「任何 bug 都不应该让会话打不开才对吧,也不应该有任何需要横幅性质的
 * ui 表达,有问题就像消息一样贴消息列表才对吧」。
 *
 * 故障和「模型回了一段话」「上下文被压缩了」是同一类东西 —— **这条对话里发生的一件事**。
 * 既然属于这条对话，它的位置就是消息列表里的一行，按时间排在该在的地方。
 * 横幅 / 整页覆盖的存在前提是「这件事不属于这条对话，所以得另找地方贴」，而那个前提是假的。
 *
 * ⚠️ 这不是新规矩，是没还的账：`session-history-replay` 的合同里已经写着
 * 「**『打不开』不是一种可接受的降级形态**——它等于产品在这条对话上不可用，属于 P0 故障」，
 * 而 `session/load` 失败那条路（见 {@link transcriptContextResetSchema}）早就照它办了。
 * 后来加的每个功能又各自把「起不来就整页替换」引了回来，于是同一条裁决要在每个点上重打一遍。
 * 这个 schema 就是那个统一的落点。
 *
 * # 与 `context-reset` / `compaction` 的分界
 *
 * 三者同族、都是转录里的独立一行，但说的不是一件事，❌ 别合并：
 * - `compaction` —— agent 手里还有一份摘要；
 * - `context-reset` —— agent 手里**什么都没有**，往上的内容它没读过；
 * - `session-notice` —— **上下文没问题**，是这条会话的运行条件出了事（引擎、模型、登录、连接），
 *   或它的身份变了（改名）。
 */
export const sessionNoticeCodeSchema = z.enum([
  /**
   * 会话创建时选的模型，provider 现在用不了（下架 / 改名到认不出 / 被 settings 排除）。
   * 会话照常开在 provider 自己的默认模型上 —— ❌ 不是打不开。
   */
  'model-unavailable',
  /**
   * provider 收下了一个它目录里确实有的模型 id，却停在别处 ⇒ 用户选的和实际在跑的不是一个东西。
   * ⚠️ 别名被规范化（`opus` → `opus[1m]`）**不属于**这一条，那跑的就是用户要的东西。
   */
  'model-substituted',
  /**
   * 会话创建时选的推理档，provider 对当前模型不接受（#6199：codex 对 glm-5.3 拒收 `ultra`）。
   * 会话照常开在 provider 报的那一档上（`effectiveValue`）—— ❌ 不是把首句扣在队列里。
   */
  'effort-unavailable',
  /**
   * #6396 这条会话的 agent 被改了名:它起来时用的名字(`previousValue`)在它登记到云端时已经用过了
   * (序号只增不减,另一台设备先用了、或以前的 agent 用过),登记成了下一个没用过的名字(`effectiveValue`)。
   * 名字就是寻址名,所以这件事必须留在对话里 —— ❌ 不是侧栏上的名字悄悄变了。
   */
  'agent-renamed',
  /**
   * 供应商自己发来的提示(ACP `notice`)。行上画 `title` 原文,`detail` 是 description(没有就是 title)。
   * 每来一次是一件事 ⇒ 一行,❌ 按 code 并成一行。
   */
  'provider-notice',
]);
export type SessionNoticeCode = z.infer<typeof sessionNoticeCodeSchema>;

export const transcriptSessionNoticeSchema = z.object({
  kind: z.literal('session-notice'),
  /** `${turnId}:session-notice:${code}`：同一条会话的同一件事只画一行，重复推送落回同一行。 */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  /** 哪一件事。界面按它给文案与内联动作，❌ 不去匹配 detail 里的文字。 */
  code: sessionNoticeCodeSchema,
  /**
   * 运行时 / provider 自己那句原文。**必须带**：`session-history-replay` 的合同是
   * 「截断与失败都要留下可诊断的痕迹」，只画一行而不留原因，事后没有任何东西能分开
   * 「这个模型下架了」与「用户的 settings 把它排除了」。
   */
  detail: z.string(),
  /**
   * 事后实际生效的值（模型这一维就是真正在跑的那个 id）。有值时界面才说得出
   * 「现在用的是 X」这句话 —— 没有它，用户只知道自己选的那个不行，不知道现在跑的是什么。
   */
  effectiveValue: z.string().optional(),
  /** 事前的值(改名这一条就是原来的名字)。和 `effectiveValue` 成对才说得出「X 改成了 Y」。 */
  previousValue: z.string().optional(),
  /** 供应商那句标题(只有 `provider-notice` 带)。 */
  title: z.string().optional(),
  /** Epoch ms when it happened. */
  at: z.number(),
});
export type TranscriptSessionNotice = z.infer<typeof transcriptSessionNoticeSchema>;

/**
 * 钩子说话的那一层格式:逐行 `<Hook> says: `(`Stop says: ` / `SessionStart:compact says: `)。
 * ❌ 不写白名单:hook 事件名是上游的、会加。按**形状**认:一个或几个大驼峰词,可带 `:来源` 限定。
 */
const HOOK_SPEAKER = /^((?:[A-Z][A-Za-z]*)(?: [A-Z][A-Za-z]*)*(?::\S+)?) says: /;

/** 这一行是哪个 hook 说的;不是这种形状就 null。 */
export function hookSpeakerOfLine(line: string): string | null {
  return HOOK_SPEAKER.exec(line)?.[1] ?? null;
}

/**
 * 这条 `provider-notice` 其实是钩子说的话吗 —— 是就返回说话的 hook(#55)。
 *
 * 桥声明了 `session.notices`(#6596)之后,Claude 的 informational(钩子的输出)以 ACP `notice` 来:
 * `title` = 第一行,`detail` = 其余几行;第一行太长时 `title` 是桥的通用标题、整段进 `detail`
 * (`claude-agent-acp` `splitNoticeText`)。桥没给钩子单独的 code,所以只能照钩子那一层的编码读回来:
 * **每一行**都是同一个说话人才算 —— 只看第一行,任何以「X says:」开头的提示都会被认成钩子。
 *
 * ⚠️ 这是上面「❌ 不去匹配 detail 里的文字」的唯一例外,而且只在这里:界面要知道「这是不是钩子」
 * 就问这个函数,❌ 自己再写一遍。存下来的旧转录不带别的标记,所以判定只能在读的时候做,不在解码时打标。
 */
export function hookSpeakerOfNotice(notice: Pick<TranscriptSessionNotice, 'code' | 'title' | 'detail'>): string | null {
  if (notice.code !== 'provider-notice') return null;
  const title = notice.title ?? '';
  // detail 与 title 相同 = 只有一行;title 认不出 = 桥换了通用标题,整段都在 detail 里。
  const lines = hookSpeakerOfLine(title) === null
    ? notice.detail.split('\n')
    : notice.detail === title ? [title] : [title, ...notice.detail.split('\n')];
  const speaker = hookSpeakerOfLine(lines[0] ?? '');
  if (speaker === null) return null;
  return lines.every((line) => line.trim() === '' || hookSpeakerOfLine(line) === speaker) ? speaker : null;
}
