/** @jsxImportSource solid-js */
/**
 * turn-outcome —— 一个 turn 结束后的收尾行（对照表 #12 error-state / #18 stopped-run）。
 *
 * # ⚠️ 上游三颗按钮的去向：retry ❌ / continue ✅ / discard ✅
 *
 * 上游 `elements-error-state` 有 retry、`elements-stopped-run` 有 continue/discard。
 *
 * ⚠️ **这一段此前把 retry 与 continue 并列判成「都做不到」，那是错的**，而且是在同一条证据链里
 * 错的：⑤ 自己写着「`cancel` 之后会话是活的」，却接着断言 continue 做不到 —— 它把
 * **rewind**（原样续写被切断的那半句，协议里确实没有）与 **continue**（在那个还活着的会话里
 * 再发一条「接着往下」的指令，一直都有）当成了同一件事。上游自己也没做 rewind：官方文档写明
 * `reload()` “Restarts generation; it does not resume the cut-off text.” ⇒ 上游的 continue
 * 就是「在这一轮上重新起跑」，而这件事本仓做得到、现在也做了（`onContinueTurn`）。
 *
 * discard 也画了 —— 见 ⑤。只有 retry 依旧不画，理由在下面 ①–④，是查出来的证据链，
 * 不是「handler 的名字看着不像」：
 *
 * ① **协议层没有。** ACP 客户端接口的方法全集是
 *    `initialize / newSession / loadSession / prompt / cancel / setSessionConfigOption /
 *    setSessionMode / closeSession`（`session-core/src/agents/plugins/capabilities/acp.ts:52-67`）。
 *    没有 retry、没有 rewind、没有 truncate、没有 resume-turn。
 * ② **命令层没有。** `session-core/src/acp/api/contract.ts` 的 18 条命令里同样没有。
 *    阳性对照：同一把尺子在 `acp/` + `acp-agents/` + renderer `lib/acp/` 里查 `cancel`
 *    命中 73 处，查 `retry|resend|continue` 只命中循环里的 `continue` 语句 ⇒
 *    读到 0 是真阴性，不是仪器坏了。
 * ③ **能到达用户眼前的 error 就那几种。** `settleTurn` 全仓的调用点读完:live runtime 产出
 *    `done` / `cancelled` / `error`。
 *    ⚠️ 2026-09-20(#5858 / #4875)更正这一条的后半句:当年写的是「只有 `error:prompt_failed`
 *    一种,`interrupted` 那一支没有任何生产者」。前半句**是缺陷不是事实** —— 引擎死了与上游拒了
 *    共用同一个哨兵值,用户分不出;现在进程退出落 `error:process_closed`,并带着退出码/信号/
 *    stderr 尾巴。后半句当年属实,而那支死枚举已经删掉(见 `session-core` 的 `turn.ts` 抬头)。
 * ④ ⇒ 于是「重试」的唯一候选实现是把同一条 prompt 再发一次。而 `prompt_failed` 是
 *    `agent.prompt()` 整个调用抛出来的（`cell.ts:559-573`）——**它包住的是一整轮**，
 *    抛出来之前 agent 可能已经写过文件、调过工具。加上 ① 的「没有 rewind」，
 *    再发一次就是在一段**已经含着那次失败与它的副作用**的上下文后面追加第二条指令。
 *    **重发不是重试。** 不等价还接上去，就是一个会骗人的按钮 —— 比没有按钮更糟。
 * ⑤ **discard 画了，但它的语义比上游窄一格，而这一格必须说出来。** 上游那颗接
 *    `aui.message.delete()`，删的是**它自己 runtime 里的那条消息**，而那份 thread state 就是
 *    喂给模型的上下文 ⇒ 在上游，删掉即等于模型也忘了。本仓不是这个形状：上下文在 agent 进程里，
 *    transcript 只是它的一份投影，协议全集（见 ①）里没有删除 turn 的动词。
 *    ⇒ 这里的「丢弃」拿掉的是**这一次看到的列表**：那一轮的助手输出与这一行一起从对话里消失，
 *    只留用户自己那条指令；重开会话会从 provider 重放，它会回来。
 *    这正是上游**独立用法**给出的语义（官方文档原话：discard 就是「whatever removes the draft
 *    from your own list」）⇒ 不是降级，是这个动作在本仓的真实落点。
 *    ⚠️ 差的那一格写在按钮的无障碍名字里（「agent 那边仍然记得」），❌ 不许让用户以为自己撤销了什么。
 *
 * ⇒ 只剩 retry 那一个缺口，连同「要做的话需要先有什么」记在 **#3529**：它要的是 turn 级的 rewind，
 * 那是协议侧的事。❌ 不要因为「上游有」就把它补上。
 *
 * # 那么这一行**能**真做的是什么
 *
 * 这张票说的死路是具体的：一轮出错或被停之后，**用户只能自己重打一遍指令**。
 * 那条指令还在 transcript 里 —— 缺的不是能力，只是把它拿回来的路。
 *
 * 所以这一行接的是 `onRestorePrompt`：**把这一轮的原始指令放回输入框，不发送**。
 * 它做的事与它说的话逐字相同，可当场证伪（输入框里有没有那段字）。
 * 要不要真的再跑一次由用户按发送决定 —— ④ 那个不可判定的副作用风险，
 * 交给唯一判断得了它的那个人，而不是由一个按钮替他假设。
 *
 * 而**被停止**的那一支还多一颗「继续」（`onContinueTurn`）：它向那个还活着的会话再发一条
 * 指令，agent 的上下文里带着刚才那半截输出 ⇒ 它读到的是「你写到一半被打断了，接着做」。
 * 它同样不假装能原样续写那半句。两颗按钮的分工与「为什么这颗能接、`onRestorePrompt` 那颗
 * 明令不许接成发送」逐句写在 `commands.ts` 的 `onContinueTurn` 上。
 *
 * # 高度：默认单行，展开原文时才长高
 *
 * 上游 error-state 与 stopped-run 都是带内距的多行块。我们**不照搬那个形状** —— transcript 是
 * 离屏测量 + 虚拟化，`measure()` 与真实 DOM 高度不一致会让行重叠/跳动（`height.contract.test.tsx`
 * 守着）。徽章与动作按钮都做成 20px 高的行内胶囊，塞在 32px 的 `ROW_H` 里 ⇒ 默认那一行的
 * `measure()` 一个字都不用改。这里取的是上游的**解剖**（语义 role、可读文案、`data-slot` 命名、
 * 「徽章 + 动作」那条 lane），不是它的像素。
 *
 * ⚠️ 2026-09-20(#5858)这一段收回半句:此前写的是「这一族也就不需要 `ctx.expanded(id)` 那条
 * 变高路径」。它**需要**了 —— 但只在用户自己点开「详情」的时候。理由是真机读数:provider 的原文
 * 当时只住在徽章的 `title` 里,而「三种毫不相干的真因在屏幕上是同一句话」正是票的缺陷;
 * tooltip 要悬停一枚 24px 的胶囊才出得来,拿不到鼠标的人根本读不到。
 * ⇒ 收起时仍然是常量 `ROW_H`(那一格的契约一个字没动),展开后 = lane + 那块原文,
 *   两者由 `turnOutcomeDetailId` **同一个开关**决定,判据在 `tests/turn-outcome-detail.contract.test.tsx`。
 *
 * ⚠️ 上游 stopped-run 的**上半条**（停之前流出来的 `words` + 一枚光标）本仓不移植：那半条解决的是
 * 「run 停了以后半截答案没地方待」，而在这里它一直待在自己的行里（正文行 / 工具行）—— 再画一遍
 * 就是把同一段内容在屏幕上放两份。移植的是下半条那条 lane，逐条对照见 `turn-outcome.css.ts`。
 *
 * ⚠️ 那枚光标**曾经**被摆在这条 lane 的行首（理由是「下一个字本该出现的位置」）。owner 拿上游 demo
 * 实机对照后判掉了：上游的光标跟在那段字的**末尾、同一行**，摆到下一行行首就成了一枚孤立的竖线，
 * 上游从没有那个东西。要它就得由**正文行自己出**（那一行有自己的行盒排版与 `measure()`），
 * 且那时还得处理「这一轮最后一件东西不是文字而是工具行 / diff」的情形。⇒ 这条 lane 上不画。
 *
 * # ⚠️ 尺寸照抄，别再自己收紧
 *
 * 第一版把上游的数值整体缩了一档（徽章 20px / 按钮 20px / gap 6px，而上游是 24 / 28 / 8），
 * 又把按钮紧贴在徽章右边（上游是 `ms-auto` 顶到最右），于是同一副骨架画出来小一圈、挤成一条。
 * owner 实机对照 demo 后指出差别明显。
 * ⇒ `turn-outcome.css.ts` 里每一项都标了上游的原值，改之前先看那一列。
 *
 * # ⚠️ 为什么**失败**行没有图标，而**被停止**行有一枚方块
 *
 * 失败行**曾经**有一枚 `IconError`，而那枚字形与工具行状态槽里的那枚是同一个组件 ⇒ 一次工具失败
 * 会在相邻两行的左右两端各画一个一模一样的红叉：一个管那一次调用，一个管整轮，屏幕上无从分辨
 * （#3568）。现在失败行的作用域记号是**跨度**（行尾那一条发丝线），不是字形；判据在
 * `tests/failure-scope.contract.test.tsx`，完整理由在 `turn-outcome.css.ts`。
 *
 * `cancelled` 那一支的徽章里有一枚 `IconStop`，这**不是**把 #3568 改回去：
 * ① 它不出现在失败行上，而那条判据读的正是失败行 ⇒ 两个作用域的字形交集照样为空；
 * ② 它说的不是「这里出错了」而是「你按了停止」—— 与用户消息卡上那颗停止按钮是**同一个组件**，
 *    按下去的那枚与留下来的那枚同形，且两者永不同框（一个在轮子跑的时候，一个在它停下之后）；
 * ③ 这一行本来就已经有一枚合法的 turn 级字形（「取回指令」那颗 `IconRestorePrompt`）⇒
 *    #3568 判的从来不是「收尾行不许有字形」，而是**同一枚字形不得同时替两种范围说话**。
 */
import { readableLabel, rowTranslator, wrappedRowHeight } from '../readable-label';
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import {
  IconContinueTurn,
  IconRestorePrompt,
  IconStop,
} from '@session-chat/components/primitives/icons';
import { defineUnit } from '@session-chat/core/units';
import { turnDiscardedId, turnOutcomeDetailId } from '@session-chat/state/flatten';
import type { TranscriptTurnOutcome, TurnOutcomeItem } from '@session-chat/model';
import { vars } from '@session-chat/styles/theme.css';
import { Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useChatTranslator, type ChatTranslationKey, type ChatTranslator } from '@session-chat/localization';
import {
  outcomeAction,
  outcomeActionPrimary,
  outcomeBadge,
  outcomeBadgeDisclosing,
  DETAIL_LINE_H,
  DETAIL_PAD_Y,
  outcomeDetail as outcomeDetailBand,
  outcomeShell,
  outcomeBadgeGlyph,
  outcomeBadgeLabel,
  outcomeBadgeSeparator,
  outcomeReason,
  outcomeRow,
  outcomeRuleTrail,
  outcomeSpacer,
} from './turn-outcome.css';

type OutcomeOf<K extends TranscriptTurnOutcome['kind']> = Extract<TranscriptTurnOutcome, { kind: K }>;
type ErrorReason = NonNullable<OutcomeOf<'error'>['reason']>;
type CancelledReason = NonNullable<OutcomeOf<'cancelled'>['reason']>;

/**
 * 内部枚举 → 人话文案键。**类型上穷尽**：少一个键编译不过，
 * 所以 ACP 新增枚举值时这里会红，而不是把标识符漏给用户。
 */
const ERROR_REASON_KEY: Record<ErrorReason, ChatTranslationKey> = {
  prompt_failed: 'transcript.reasonPromptFailed',
  process_closed: 'transcript.reasonProcessClosed',
  spawn_failed: 'transcript.reasonSpawnFailed',
  initialize_failed: 'transcript.reasonInitializeFailed',
  new_session_failed: 'transcript.reasonNewSessionFailed',
  load_session_failed: 'transcript.reasonLoadSessionFailed',
  cancel_failed: 'transcript.reasonCancelFailed',
  set_config_failed: 'transcript.reasonSetConfigFailed',
  set_mode_failed: 'transcript.reasonSetModeFailed',
};

const CANCELLED_REASON_KEY: Record<CancelledReason, ChatTranslationKey> = {
  cancelled: 'transcript.reasonCancelledByUser',
  interrupted_for_message: 'transcript.reasonInterruptedForMessage',
};

/** 原因的人话说明；没有 reason 时返回 null（文案自己已经说清了发生什么）。 */
function reasonText(outcome: TranscriptTurnOutcome, translate: ChatTranslator): string | null {
  switch (outcome.kind) {
    case 'error':
      // #6264 因为这家的登录不能用了才失败的那一轮:原因直说「需要登录」(失效与从没登录过都是它,下面那一行再分),
      // ❌ 笼统的「回合未能完成」。
      // 「重新登录」那段字在消息列表末尾的条件行里(登上之后那一行自己消失),不挤进这条 32px 的 lane。
      if (outcome.signInRequired) return translate('transcript.reasonSignInRequired');
      // #7103 上游自己说了的(网关回给 codex 的那一句):直接说它,❌ 笼统的「回合未能完成」。原文照旧在详情里。
      if (outcome.said) return outcome.said;
      return outcome.reason ? translate(ERROR_REASON_KEY[outcome.reason]) : null;
    case 'cancelled':
      return outcome.reason ? translate(CANCELLED_REASON_KEY[outcome.reason]) : null;
    default:
      return null;
  }
}

function outcomeLabel(outcome: TranscriptTurnOutcome, translate: ChatTranslator): string {
  switch (outcome.kind) {
    case 'cancelled':
      return translate('transcript.turnCancelled', { reason: '' });
    case 'error':
      return translate('transcript.turnFailed', { reason: '' });
    case 'done':
      return translate('transcript.turnCompleted', { reason: '' });
    default:
      return translate('transcript.turnFinished', { reason: '' });
  }
}

function outcomeDetail(outcome: TranscriptTurnOutcome): string | null {
  if (outcome.kind !== 'error') return null;
  const detail = outcome.detail?.trim();
  return detail || null;
}

/**
 * 展开后那块原文一次给几行。
 *
 * 封顶的理由是**高度契约**,不是审美:这一族的 `measure()` 必须与真实 DOM 高度一致
 * (`height.contract.test.tsx` 守着),而"一段任意长的文字换行后有多高"在离屏测量里算不准。
 * ⇒ 高度按**源文里的行数**算(换行符,不猜折行),封顶之后那块框自己滚 ——
 * **一个字都没被截掉**,只是一次看几行。这正是仓规那句「超长在 UI 侧折叠,不在数据侧砍」。
 */
const DETAIL_MAX_LINES = 6;

function detailBandHeight(detail: string | null): number {
  if (!detail) return 0;
  const lines = Math.min(detail.split('\n').length, DETAIL_MAX_LINES);
  return lines * DETAIL_LINE_H + 2 * DETAIL_PAD_Y;
}

/**
 * 徽章里的两截话。
 *
 * ⚠️ **`cancelled` 这一支只说一遍。** 它原本渲染的是「回合已取消」+「你停止了这一轮」——
 * 同一件事说了两遍，而这正是这一行读起来像一条日志而不像一个控件的一半原因（另一半是它没有
 * 任何 chrome，由 `outcomeBadge` 负责）。停止这一支的原因文案**自己就把两件事都点了名**：
 * 范围（这一轮）与原因（你停的）⇒ 它就是这一行的全部说辞，通用标签在它旁边不增加任何信息。
 *
 * ⚠️ 其余各支**不能照此收掉标签**：`product spec…/task-chat-ui/spec.md` 立的判据是「收尾行不画字形，
 * 因为它的文案自己点了名——说的是**这一轮**怎么了」。而「配置未能应用」「未能载入已有会话」
 * 这些原因说的是**哪件事**失败，没说这一轮到此为止 ⇒ 收掉「回合失败」就会把那条判据的前提抽走。
 * 于是它们是「说辞 · 原因」两截，只有 cancelled 是一截。
 */
function badgeParts(
  outcome: TranscriptTurnOutcome,
  translate: ChatTranslator
): { label: string; reason: string | null } {
  const reason = reasonText(outcome, translate);
  if (outcome.kind === 'cancelled' && reason) return { label: reason, reason: null };
  return { label: outcomeLabel(outcome, translate), reason };
}

function outcomeLaneLayout(data: TurnOutcomeItem, ctx: import('@session-chat/core/define').MeasureCtx) {
  const t = rowTranslator(ctx), outcome = data.outcome, commands = ctx.commands;
  const refused = outcome.kind === 'error' && outcome.guguReason ? commands?.describeRefusal?.(outcome.guguReason) : null;
  const parts = badgeParts(outcome, t);
  const reason = refused?.text ?? parts.reason;
  const glyph = outcome.kind === 'cancelled' ? 16 : 0;
  const label = readableLabel(parts.label, ctx, ctx.width - 20 - glyph, 12, 18);
  const natural = label.width + (reason ? readableLabel(reason, ctx).width + 16 : 0) + 20 + glyph;
  const badgeWidth = Math.min(ctx.width, natural);
  const description = reason ? readableLabel(reason, ctx, badgeWidth - 20 - glyph - label.width - 16) : null;
  const badgeHeight = Math.max(24, label.height + 6, (description?.height ?? 0) + 6);
  const actions: number[] = [];
  const actionWidth = (text: string, icon = false) => readableLabel(text, ctx, ctx.width, 14, 20, 500).width + 20 + (icon ? 18 : 0);
  if (refused?.action) actions.push(actionWidth(refused.action.label));
  if (outcome.kind === 'cancelled' && outcome.reason !== 'interrupted_for_message') {
    if (commands?.onContinueTurn) actions.push(actionWidth(t('transcript.continueTurn'), true));
    actions.push(actionWidth(t('transcript.discardTurn')));
  } else if (outcome.kind !== 'cancelled' && !refused?.action && data.prompt && commands?.onRestorePrompt) actions.push(actionWidth(t('transcript.restorePrompt'), true));
  const rule = outcome.kind !== 'cancelled' ? [{ width: 8, height: 1 }] : [];
  const wrapped = badgeWidth + actions.reduce((sum, value) => sum + value + 8, 0) + (rule.length ? 16 : 0) > ctx.width;
  const height = wrappedRowHeight([{ width: badgeWidth, height: badgeHeight }, ...rule, ...actions.map(width => ({ width, height: 28 }))], ctx.width, 8, 4);
  return { label, reason: description, badgeWidth, badgeHeight, wrapped, height: Math.max(32, height + 4) };
}

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  // 上游把这条 lane 与上面那段字之间留了 `gap-3`（12px）—— 那正是它看起来「有呼吸」的来源，
  // 而 lane 本身反倒是紧的。本仓这一份呼吸只能落在 margin 上（行高是常量、内部塞不下）：
  // 8 + 行内 (32-28)/2 = 10px，取到 12 的同时不动 measure()。
  margin: { top: 8, bottom: 4 },
  vars: { rowH: ROW_H },

  /**
   * lane 永远是常量 `ROW_H`;展开后再加上那块原文的高度。
   *
   * ⚠️ 读的开关必须与 `Render` 里那颗**同一个 id**(`turnOutcomeDetailId`)——
   * 量高度与画内容各读各的开关,行就会长成一个高度与内容对不上的框。
   */
  measure(data, ctx) {
    const detail = outcomeDetail(data.outcome);
    if (!detail || !ctx.expanded(turnOutcomeDetailId(data.turnId))) return outcomeLaneLayout(data, ctx).height;
    return outcomeLaneLayout(data, ctx).height + detailBandHeight(detail);
  },

  Render(props) {
    const translate = useChatTranslator();
    const lane = () => outcomeLaneLayout(props.data, props.ctx.measureCtx!());
    const commands = useCommands();
    const isError = () => props.data.outcome.kind === 'error';
    const isCancelled = () => props.data.outcome.kind === 'cancelled';
    // 为插话停下的一轮:下一轮就是接着干(那条消息),所以❌ 没有「继续 / 丢弃」可言。
    const isUserStopped = () =>
      props.data.outcome.kind === 'cancelled' && props.data.outcome.reason !== 'interrupted_for_message';
    // #7103 咕咕拒了这一轮的票:原因那一截与那颗按钮都由宿主按原因表给。
    const refusal = () => {
      const outcome = props.data.outcome;
      const describe = commands().describeRefusal;
      return outcome.kind === 'error' && outcome.guguReason && describe ? describe(outcome.guguReason) : null;
    };
    const parts = () => {
      const refused = refusal();
      const base = badgeParts(props.data.outcome, translate);
      return refused ? { ...base, reason: refused.text } : base;
    };
    const detail = () => outcomeDetail(props.data.outcome);

    /**
     * 两个门都得开：宿主接了回调 **且** 这一轮真有一条可还的用户指令。
     * 缺任何一个都不渲染 —— 本仓铁律「控件要么真生效，要么不渲染」在这里是结构约束，
     * 不是靠人记得别渲染。
     */
    /**
     * 「继续」的两个门：宿主接了回调 **且** 这一轮是**被停止**的。
     * 失败 / 中断没有「接着往下」这回事 —— 那两支不是话说到一半，是这一轮没能进行下去。
     */
    const continuable = () => {
      if (!isUserStopped()) return null;
      const go = commands().onContinueTurn;
      if (!go) return null;
      return { go };
    };

    const restorable = () => {
      // ⚠️ 被停止那一支**不出这颗**。上游 stopped-run 的 lane 上只有 Continue 与 Discard，
      // 而「取回指令」是本仓给 error-state 那一族做的东西 —— 把它塞进 stopped-run 的位置，
      // 就是拿自家控件顶掉上游的设计。owner 连下四次「严格遵循人家的设计」，指的正是这里。
      if (isCancelled() || refusal()?.action) return null;
      const text = props.data.prompt;
      if (!text) return null;
      const restore = commands().onRestorePrompt;
      if (!restore) return null;
      return { text, restore };
    };

    const detailId = () => turnOutcomeDetailId(props.data.turnId);
    // 反转语义:存下来的 "collapsed" 就是「展开了」—— 与 `ctx.expanded(id)` 同一个开关。
    const detailOpen = () => Boolean(detail()) && props.ctx.viewState.isCollapsed(detailId());
    const detailH = () => {
      const text = detail();
      if (!text || !detailOpen()) return 0;
      const lines = Math.min(text.split('\n').length, DETAIL_MAX_LINES);
      return lines * DETAIL_LINE_H + 2 * DETAIL_PAD_Y;
    };

    return (
      <div
        data-slot="turn-outcome"
        data-outcome={props.data.outcome.kind}
        data-detail-open={detailOpen() ? 'true' : undefined}
        class={outcomeShell}
        style={{ height: `${lane().height + detailH()}px` }}
      >
        <div
          data-slot="turn-outcome-lane"
          // error 用 alert（打断读屏，因为它要求用户注意）；其余用 status（礼貌播报）。
          role={isError() ? 'alert' : 'status'}
          class={outcomeRow}
          style={{
            height: `${lane().height}px`,
            'flex-wrap': 'wrap', 'row-gap': '4px',
            color: isError() ? vars.fgError : vars.fgMuted,
          }}
        >
          {/* 徽章：上游 `elements-stopped-run` 下半条的那颗 pill。行里的一切读的都是 accessor
              （`parts()` / `isCancelled()`），❌ 不在 Show 回调外把它们捕获成常量 —— 行组件按下标
              复用，捕获过的值换单元时不会重算（对照钉在 turn-process-fold.contract.test.tsx）。 */}
          <Dynamic
            style={{ width: `${lane().badgeWidth}px`, height: `${lane().badgeHeight}px` }}
            component={detail() ? 'button' : 'span'}
            type={detail() ? 'button' : undefined}
            data-slot="turn-outcome-badge"
            // 有原文可看时,**整颗徽章就是那个开关** —— lane 上❌ 不多放一颗按钮、徽章里也
            // ❌ 不多一截字:两者都会把 `outcomeRuleTrail`(失败作用域的记号)的剩余空间吃掉,
            // #3568 的契约当场红(两次都实测过,算账写在 turn-outcome.css.ts)。
            // 可见性由那圈 inset 描边给(不参与布局);走的仍是 ChatRoot 既有的点击委派。
            data-detail-toggle={detail() ? 'true' : undefined}
            data-collapse-id={detail() ? detailId() : undefined}
            // 开关的 id 带命名空间后缀,`unitIndexOf` 查不到 ⇒ 这里报出自己所在的那一行,
            // 让滚动锚点钉得住(否则点开视口上方那一行时,transcript 会在读者眼皮底下跳)。
            data-collapse-anchor={detail() ? props.data.id : undefined}
            aria-expanded={detail() ? (detailOpen() ? 'true' : 'false') : undefined}
            class={detail() ? `${outcomeBadge} ${outcomeBadgeDisclosing}` : outcomeBadge}
            // aria-label 会**整条顶掉**可见文案的无障碍名 ⇒ 两截话都得带上，否则读屏用户听到的是
            // 「回合失败: <原文>」,丢了「这一轮怎么了」那半句。❌ 别写成 `{...(detail() ? {…} : {})}`:
            // spread 里的 `detail()` 只在创建那一刻求值一次,而行组件按下标复用 ⇒ 换单元时不重算。
            aria-label={
              detail()
                ? `${[parts().label, parts().reason].filter(Boolean).join(' · ')}: ${detail()}`
                : undefined
            }
            // ⚠️ `title` **就是 detail 本身,一个字不多** —— `failure-scope.contract.test.tsx`
            // 有一条判据对它做逐字相等(「错误详情保留在徽章的悬浮提示中」)。
            // 「这颗可以点开」那件事❌ 不往这里塞:它由 button 角色 + `aria-expanded`
            // (读屏会念「折叠/展开」)+ 那圈 inset 描边 + 指针来说 —— 这就是 disclosure 的标准形状,
            // 不需要再编一句文案,也就不必去动别人那条判据。
            title={detail() ?? undefined}
          >
            <Show when={isCancelled()}>
              <span data-slot="turn-outcome-badge-glyph" aria-hidden="true" class={outcomeBadgeGlyph}>
                <IconStop />
              </span>
            </Show>
            <span data-slot="turn-outcome-label" class={outcomeBadgeLabel}>{lane().label.text}</span>
            <Show when={parts().reason}>
              {(text) => (
                <>
                  <span aria-hidden="true" class={outcomeBadgeSeparator}>
                    ·
                  </span>
                  <span data-slot="turn-outcome-reason" class={outcomeReason}>
                    {lane().reason?.text ?? text()}
                  </span>
                </>
              )}
            </Show>
          </Dynamic>
          {/* 这一段宽度办两件事：把动作顶到右边（上游那两颗按钮的 `ms-auto`），
              并在**失败 / 中断**上兼作作用域记号那条发丝线（#3568）。
              被停止不是失败 ⇒ 那一支只留空白，与上游 lane 一致。理由见 turn-outcome.css.ts。 */}
          <Show
            when={isCancelled()}
            fallback={
              <span
                data-slot="turn-outcome-rule"
                data-rule="trail"
                aria-hidden="true"
                class={outcomeRuleTrail} style={{ 'min-width': lane().wrapped ? '8px' : undefined }}
              />
            }
          >
            <span data-slot="turn-outcome-spacer" aria-hidden="true" class={outcomeSpacer} style={{ display: lane().wrapped ? 'none' : undefined }} />
          </Show>
          <Show when={refusal()?.action}>
            {(action) => (
              <button
                type="button"
                data-slot="turn-outcome-refusal-action"
                class={outcomeActionPrimary}
                onClick={() => action().run()}
              >
                {action().label}
              </button>
            )}
          </Show>
          <Show when={continuable()}>
            {(target) => (
              <button
                type="button"
                data-slot="turn-outcome-continue"
                class={outcomeActionPrimary}
                // 可见文案只有「继续」；它**会发出一条新指令**这件事写进无障碍名字，
                // 免得一颗 12px 的胶囊悄悄替用户按下发送。
                aria-label={translate('transcript.continueTurnHint')}
                title={translate('transcript.continueTurnHint')}
                onClick={() => target().go({ itemId: props.data.id, source: 'turn-outcome' })}
              >
                {translate('transcript.continueTurn')}
                <IconContinueTurn />
              </button>
            )}
          </Show>
          {/* 「丢弃」——上游 stopped-run 的第二颗。它把这一轮 agent 写到一半的输出从对话里拿掉，
              只留用户自己那条指令（上游删的也正是那条被取消的助手消息）。
              身上挂 `data-collapse-id` ⇒ 走 ChatRoot 里既有的那条点击委派，不经宿主回调。
              ⚠️ 它拿掉的是**这一次看**：重开会话会从 provider 重放，那一轮会回来。ACP 里没有删除
              turn 的动词（agent 面九个方法读过，`forkSession` 也只按会话整条分叉），所以任何本地
              实现都到不了「模型也忘了」。上游独立用法给的正是这个语义：把它从你自己的列表里拿掉。 */}
          <Show when={isUserStopped() && commands().canDiscardTurn?.(props.data.turnId) !== false}>
            <button
              type="button"
              // Native: the transcript's click delegate toggles this row away before a delegated handler would run.
              on:click={() => commands().onDiscardTurn?.({ turnId: props.data.turnId })}
              data-slot="turn-outcome-discard"
              data-collapse-id={turnDiscardedId(props.data.turnId)}
              class={outcomeAction}
              aria-label={translate('transcript.discardTurnHint')}
              title={translate('transcript.discardTurnHint')}
            >
              {translate('transcript.discardTurn')}
            </button>
          </Show>
          <Show when={restorable()}>
            {(target) => (
              <button
                type="button"
                data-slot="turn-outcome-action"
                class={outcomeAction}
                // 可见文案只说「取回指令」；完整承诺（**不会自动重发**）写在无障碍名字里，
                // 免得一个 12px 的胶囊替产品许下它兑现不了的话。
                aria-label={translate('transcript.restorePromptHint')}
                title={translate('transcript.restorePromptHint')}
                onClick={() =>
                  target().restore({
                    itemId: props.data.id,
                    text: target().text,
                    source: 'turn-outcome',
                  })
                }
              >
                <IconRestorePrompt />
                {translate('transcript.restorePrompt')}
              </button>
            )}
          </Show>
        </div>
        {/* 原文,逐字。`pre` 而不是 `div`:里面常常是多行(退出码 + 适配器 stderr 的尾巴、
            或者上游那句话 + 它的结构化负载),空白与换行都是内容的一部分。
            高度封顶后自己滚 ⇒ 一个字都没被截掉,只是一次看几行。 */}
        <Show when={detailOpen()}>
          <pre
            data-slot="turn-outcome-detail"
            class={outcomeDetailBand}
            style={{ height: `${detailH()}px` }}
          >
            {detail()}
          </pre>
        </Show>
      </div>
    );
  },
});
