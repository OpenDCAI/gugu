/**
 * 一轮工作的过程折叠:哪些条目折进时间头、头上写什么(#4874 → #4981)。
 *
 * 桌面会话页(`flatten.ts` / `turn-process.def.tsx`)与手机会话页(`thread-messages.ts`)读的都是
 * 这一份 —— 两端对「一轮怎么折、头写什么」给出同一个答案。纯函数,不碰 Solid / React。
 */
import { hookSpeakerOfNotice } from '@gugu/session-core/acp';
import type { TranscriptCompaction, TranscriptContextReset, TranscriptSessionNotice } from '@gugu/session-core/acp';
import { toolCallName } from '@gugu/session-core/acp/client';
import { isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import { agentSendOf } from '@gugu/session-core/session-record/reply-process';
import { localDayKey } from '@session-chat/lib/day-boundary';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { parseHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage, TranscriptItem, TranscriptTurn } from '@session-chat/model';
export { isEmptyAgentTurn } from './turn-visibility';

/** Returns true when the item is a user-role message (boundary seam sentinel). */
export function itemIsUser(item: ChatItem): boolean {
  return item.kind === 'message' && (item as ChatMessage).role === 'user';
}

/**
 * 这条其实是 hook 说的话（#4981）。
 *
 * ⚠️ 判定要在**这一层**做，而不是读 `item.hookNotice`：那个字段由消息单元在切段时才填
 * （见 `message.def.tsx` 的 `normalizeMessage`），而 flatten 跑在切段之前 —— 读它永远是
 * undefined，于是这两处会静静地退回旧行为。
 *
 * 两种来路都要认（#55）：桥没声明 `session.notices` 时，它是一条带等级前缀的助手消息；声明了之后
 * （gugu #6596 起），它是一条 `provider-notice`（认法在 session-core `hookSpeakerOfNotice`，只那一处）。
 * 只认前一种，钩子通知就被当成「运行条件出了事」的边界线留在外面，它前面那条真回复反被折进头里
 * —— #5350 原样回来了。
 */
function isHookNotice(item: ChatItem): boolean {
  if (item.kind === 'session-notice') return hookSpeakerOfNotice(item as TranscriptSessionNotice) !== null;
  return (
    item.kind === 'message' &&
    (item as ChatMessage).role === 'assistant' &&
    parseHookNotice((item as ChatMessage).text) !== null
  );
}

/**
 * 助手说的话。`planTurnFold` 拿它找「最后一条回复」（#4981）。
 *
 * hook 通知不算：它是**另一个说话人**塞进助手频道的一条整消息 —— 把它当回复，
 * 真正的答复就被划进 `process` 折起来看不见了。
 */
function isAssistantMessage(item: ChatItem): boolean {
  // 经 message_send / session_message 说出去的那段话也是 agent 在说话(群里派的任务,话都是这么回的):
  // 它和文字回复一样能当「最后一条回复」留在折叠外面。
  if (agentSendOf(item as TranscriptItem)) return true;
  if (item.kind !== 'message' || (item as ChatMessage).role !== 'assistant') return false;
  if (isHookNotice(item)) return false;
  // `[NO_REPLY]` 也不算:那是 agent 对一条通知的「不回」,面板根本不画它(unit-registry 返回空)。
  // 重放把一问之后的所有 cycle 并成一轮,末尾常常就是它 —— 把它当最终回复,真回复就被划进
  // process 折起来看不见(2026-09-06 真机:「做完了,子智能体已执行 sleep 40」整条进了「过程」)。
  if (isGuguSilence((item as ChatMessage).text)) return false;
  return true;
}

/** 这一条里 agent 说的话:它自己的回复,或经 message_send / session_message 说出去的那段(`agentSendOf`)。 */
function replyText(item: ChatItem): string {
  return item.kind === 'message' ? ((item as ChatMessage).text ?? '') : (agentSendOf(item as TranscriptItem)?.text ?? '');
}

/**
 * 这一条什么时候发生的 —— 段的起点只从这里读。不知道 → undefined。
 *
 * `clocked` = 这一轮自己有没有时刻(`turn.startedAt`)。回放来的轮没有:消息那时不写 `at`,
 * 会话通知却照样带一个 `at` —— 那是**回放的钟**(item-fold 的 `stampAt ?? at`),拿它当段的起点
 * 就会写出编出来的用时(#55 review)。所以通知的时刻只在有钟的轮里算数。
 */
function itemAt(item: ChatItem, clocked: boolean): number | undefined {
  if (item.kind === 'message') return (item as ChatMessage).at;
  if (item.kind === 'session-notice') return clocked ? (item as TranscriptSessionNotice).at : undefined;
  if (item.kind === 'compaction') return (item as TranscriptCompaction).startedAt;
  if (item.kind === 'context-reset') return (item as TranscriptContextReset).at;
  return undefined;
}

/**
 * 结束语与钩子之间可以夹的东西:别的通知、「后台命令 / 子智能体做完了」这类事件、`[NO_REPLY]`。
 * 它们不是 agent 又去干活了,所以不打断「钩子紧跟在结束语后面」(#55 review)。
 */
function isPassingEvent(item: ChatItem): boolean {
  if (item.kind === 'session-notice' || item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call') return true;
  return item.kind === 'message' && isGuguSilence((item as ChatMessage).text);
}

// ── Turn process fold (#4874) ─────────────────────────────────────────────────

export type TurnFoldSegment = {
  /** Everything between this segment's start and its closing reply — folded behind the header. */
  process: ChatItem[];
  /** 这一段收尾的那条回复(以及它后面不再有回复的尾巴)——留在外面。空 = 这一段没有收尾。 */
  tail: ChatItem[];
  /**
   * 这一段从什么时候开始 —— 劈开它的那条钩子通知到达的时刻(`ChatMessage.at`),
   * 或劈开它的那条边界线的时刻(压缩的 `startedAt` / 重开的 `at`,#5381)。
   * 第一段没有这一格:它的起点就是整轮的 `startedAt`。缺席 = 不知道(回放来的历史不带时刻),
   * 那一段的头就写不出用时、退回「过程」—— ❌ 别用别处的钟顶上。
   */
  startedAt?: number;
};

export type TurnFoldPlan = {
  /** The turn's opening user message(s) — always visible. */
  leading: ChatItem[];
  /** 段:一轮至少一段;钩子每把一轮劈开一次就多一段(#5350,判据见 `planTurnFold`)。 */
  segments: TurnFoldSegment[];
  /**
   * agent 在这一轮里自己说过一句有字的话(段的收尾里有一条不空的回复)。钩子的话、提问、`[NO_REPLY]`、
   * 空白都不算。agent 自己开头的一轮折不折看它(#69)—— ❌ 别从尾巴的形状再推一遍。
   */
  spoke: boolean;
};

/**
 * 第 `segment` 段折叠头的 id。第 0 段沿用原来的 `${turnId}:process` —— 绝大多数轮只有
 * 一段,换了 id 等于把所有人已经点开过的那些头的状态全丢掉。
 */
export function turnProcessId(turnId: string, segment = 0): string {
  return segment === 0 ? `${turnId}:process` : `${turnId}:process#${segment}`;
}

/**
 * Decide whether a committed turn folds, and how.
 *
 * Only a *known bad* ending blocks the fold. A turn the user cancelled — the
 * stop button and a mid-run interjection both settle as `cancelled` — or that
 * errored keeps every row: those turns carry a turn-outcome row and the process
 * is exactly what the reader came to inspect.
 *
 * An **absent** outcome does not block it. `outcome` is documented as
 * "absent = unknown", and in the committed tier unknown means one thing in
 * practice: the turn came back from replay. `loadSession` streams content, not
 * turn boundaries, so `closeActive` gets no outcome to stamp and every replayed
 * turn arrives unknown — treating unknown as "not settled" would mean a
 * reopened conversation folds nothing, which is the case the reader most wants
 * folded. Nor does folding hide anything replay still shows: the turn-outcome
 * row is driven by the same absent field, so a replayed cancelled turn already
 * renders identically to a completed one. Live turns are unaffected — every
 * live ending goes through `settleTurn` with an explicit outcome.
 *
 * 「最后一条消息」= the last assistant message; intermediate assistant text is
 * process. When the turn has no assistant message at all, everything after the
 * prompt folds and nothing trails the header.
 *
 * ── 钩子会把一轮劈成好几段（#5350）────────────────────────────────────────────
 *
 * Stop 钩子返回 `additionalContext` 时，Claude Code 的定义原话是「非报错反馈，交给模型后
 * **对话继续**」—— 钩子响完模型还会再说一段收尾。于是一轮的条目变成
 *
 *     工具… → 结束语 → 钩子通知 → 新的行动… → 结束
 *
 * 「最后一条回复」取到的是那句「结束」，真正的**结束语**就被划进 `process` 折没了
 * （2026-09-09 真机复现：`process=['c1','a-real','n1','c2']`、`tail=['a-post']`）。
 * #4981 把钩子通知本身排除出候选，只挡住了「通知排在最末尾」那一种形态。
 *
 * ⇒ 以钩子通知为界把一轮切成段：每一段自己折自己的过程、自己留一条回复在外面
 * （owner 2026-09-09 拍板：「展示的是结束语和结束这两段文本就行」）。
 *
 * ⚠️ **钩子之后 agent 没再说话就不切**。那种轮里通知往往正是「为什么停在这里」的唯一
 * 说明（`preventContinuation`），切一刀会把它折进一个新头里藏起来 —— 不切就退回原样：
 * 通知跟在结束语后面，照旧看得见。
 *
 * ── 边界线不进折叠（#5381）──────────────────────────────────────────────────
 *
 * 压缩线 / 引擎重开线不是过程：它说的是「从这里往下 agent 手里只剩摘要 / 什么都没有」，
 * 是读者判断「上面那些它还读过没有」的唯一依据。2026-09-10 真机：手敲一次 `/compact`，
 * 这一轮是 `提示 → 压缩线 → SessionStart 钩子通知`，通知不算回复、整轮没有收尾，
 * 于是线被整个收进「用时 27s ›」，不点开看不见。
 *
 * ⇒ 过程里遇到边界线就在那里切：线留在外面当前一段的尾巴，线之后另起一段、自己折自己的，
 * 线的时刻就是下一段的起点。❌ 别把线挪到头的上面或下面 —— 线两侧谁先谁后是真的，挪了就不是了。
 */
export function planTurnFold(turn: TranscriptTurn): TurnFoldPlan | null {
  if (turn.outcome && turn.outcome.kind !== 'done') return null;
  return foldable(segmentTurn(turn));
}

function foldable(plan: TurnFoldPlan): TurnFoldPlan | null {
  return plan.segments.every((segment) => segment.process.length === 0) ? null : plan;
}

/**
 * 正在跑的那一轮:agent 说了一句、接着去干活(跑命令、读文件、思考)—— 那句话已经不是收尾,它和后面的活
 * 一起算过程,头从这一刻起写「已处理 Ns」(owner 2026-10-23 真机:先开口、再连跑一分钟命令,头一直写
 * 「正在思考…」,命令明明在跑;推翻同日「第二句话的时候出现已处理多少秒」)。
 * 只看末段尾巴里那句话之后、下一条边界线 / 人说的话 / 提问之前的那一截 —— 那些照旧留在外面,收起头也看得见。
 * 只说了话、还没干活(那句话可能就是收尾)⇒ 不动,头照旧占位(`pendingTurnHeader`)。
 * 落定之后按 `planTurnFold` 重新判:那句话之后只剩工具、再没开口,它就是收尾,不折。
 */
function planLiveTurnFold(turn: TranscriptTurn): TurnFoldPlan | null {
  if (turn.outcome && turn.outcome.kind !== 'done') return null;
  const plan = segmentTurn(turn);
  const last = plan.segments[plan.segments.length - 1];
  if (last) {
    let end = 1;
    while (end < last.tail.length && !staysOutside(last.tail[end] as ChatItem)) end++;
    if (last.tail.slice(1, end).some(isWork)) {
      last.process = [...last.process, ...last.tail.slice(0, end)];
      last.tail = last.tail.slice(end);
    }
  }
  return foldable(plan);
}

/** 一轮里永远画在折叠之外的:边界线、人说的话、问人的那一下(见 `splitAtContextBoundaries`)。 */
function staysOutside(item: ChatItem): boolean {
  return isContextBoundary(item) || itemIsUser(item) || isQuestionCall(item);
}

/** agent 在干活:说话、钩子通知、路过的事件都不算。 */
function isWork(item: ChatItem): boolean {
  return item.kind !== 'message' && !agentSendOf(item as TranscriptItem) && !isPassingEvent(item) && !staysOutside(item);
}

/**
 * 一轮切成的段(钩子、边界线,判据见 `planTurnFold`),不管有没有可折的过程。`planTurnFold` 在它之上判折不折;
 * 还没有可折的过程时,占位头(`pendingTurnHeader`)读它找自己将来那颗头的位置与 id。
 */
function segmentTurn(turn: TranscriptTurn): TurnFoldPlan {
  const items = turn.items as readonly ChatItem[];
  const clocked = turn.startedAt !== undefined;
  let leadEnd = 0;
  while (leadEnd < items.length && itemIsUser(items[leadEnd])) leadEnd++;

  // 切点 = 紧跟在 agent 一句话后面的钩子通知（那句话 = 这一段的「结束语」）。
  // 通知本身不是回复（`isAssistantMessage` 已经把它排除），所以它落进下一段的过程里，
  // 而它的到达时刻正是两段的边界 —— 下一段的头拿它当起点（#5350）。
  // ⚠️ 只认「紧跟」：说完那句话 agent 又去干活了（思考、工具、压缩……），钩子就不是在它收尾之后响的
  // （#55：自动压缩之后的 `SessionStart:compact`）—— 在那里切，夹在中间的那几步会落进一段起点比它们
  // 还晚的头里。夹着的只是事件（`isPassingEvent`）不算干活。
  const cuts: { reply: number; notice: number }[] = [];
  let pendingReply = -1;
  for (let i = leadEnd; i < items.length; i++) {
    const item = items[i] as ChatItem;
    if (isAssistantMessage(item)) {
      pendingReply = i;
    } else if (isHookNotice(item)) {
      if (pendingReply !== -1) cuts.push({ reply: pendingReply, notice: i });
      pendingReply = -1;
    } else if (!isPassingEvent(item)) {
      pendingReply = -1;
    }
  }

  const segments: TurnFoldSegment[] = [];
  let start = leadEnd;
  /** 当前这一段的起点;第一段没有(它的起点是整轮的 `startedAt`)。 */
  let openedAt: number | undefined;
  for (const cut of cuts) {
    segments.push({
      process: items.slice(start, cut.reply),
      tail: [items[cut.reply] as ChatItem],
      ...(openedAt !== undefined ? { startedAt: openedAt } : {}),
    });
    start = cut.reply + 1;
    openedAt = itemAt(items[cut.notice] as ChatItem, clocked);
  }
  // 「最后一条回复」= 最后一条 agent **自己**说的话（末段之内）。
  let lastReply = -1;
  for (let i = items.length - 1; i >= start; i--) {
    if (isAssistantMessage(items[i] as ChatItem)) {
      lastReply = i;
      break;
    }
  }
  // 整轮一句话都没说、却以钩子的话收尾：那往往就是「为什么停在这里」的唯一说明（`preventContinuation`），
  // 留在外面（#55 review：钩子通知不再是边界线之后，它本会跟着过程一起折没）。
  let tailStart = lastReply;
  if (tailStart === -1 && cuts.length === 0) {
    let k = items.length;
    while (k > start && isHookNotice(items[k - 1] as ChatItem)) k--;
    if (k < items.length) tailStart = k;
  }
  segments.push({
    process: tailStart === -1 ? items.slice(start) : items.slice(start, tailStart),
    tail: tailStart === -1 ? [] : items.slice(tailStart),
    ...(openedAt !== undefined ? { startedAt: openedAt } : {}),
  });

  // 末段没有收尾的回复 ⇒ 钩子之后 agent 再没开口，这一刀白切：把它并回上一段的尾巴，
  // 结果与切之前逐条相同（通知跟在结束语后面，看得见）。
  while (segments.length > 1) {
    const last = segments[segments.length - 1] as TurnFoldSegment;
    if (last.tail.length > 0) break;
    const prev = segments[segments.length - 2] as TurnFoldSegment;
    prev.tail = [...prev.tail, ...last.process];
    segments.pop();
  }

  // Keep context boundaries, later user inputs and questions to the user outside
  // collapsed process rows. A steer/delivery is also a navigation target, even after completion.
  const visible = segments.flatMap((segment) => splitAtContextBoundaries(segment, clocked));
  const spoke = [...cuts.map((cut) => cut.reply), lastReply].some(
    (i) => i !== -1 && replyText(items[i] as ChatItem).trim().length > 0
  );
  return { leading: items.slice(0, leadEnd), segments: visible, spoke };
}

/**
 * 边界线：永远画在折叠之外的那几种行。
 * - 压缩（只剩摘要）/ 引擎重开（什么都没有）—— agent 手里的上下文从这一行往下变了；
 * - session-notice —— 这条会话的运行条件出了事（spec `session-always-openable`：它是消息列表里看得见的一行）。
 *   ⚠️ 它常落在**用户那一轮里**(启动期的降级在首句之后才落成转录),一轮成功收尾时,
 *   用户句与回复之间的全部条目会被折进「Took Ns」—— 通知跟着被折没了(#6199 B2 实测)。
 *   钩子说的话也走这条来路(`provider-notice`),但它不是运行条件:按钩子切段,❌ 当边界线(#55)。
 */
function isContextBoundary(item: ChatItem): boolean {
  if (item.kind === 'session-notice') return !isHookNotice(item);
  return item.kind === 'compaction' || item.kind === 'context-reset';
}

/**
 * 问用户的那次工具调用(提问 / 计划批准,`QUESTION_TOOL_NAMES` 与 `PLAN_APPROVAL_TOOL_NAMES`):一问一答是读者自己的一步,
 * 同后来的用户消息一样留在折叠外 —— 折进「Took Ns」就看不见问过什么、答在哪里;等人回答时那一轮还没结算,
 * 整轮收起,等着答的那一问也跟着被收走(手机 10-12 真机)。
 */
function isQuestionCall(item: ChatItem): boolean {
  return 'toolCallId' in item && isQuestionOrPlanToolName(toolCallName(item as { title: string; toolName?: string }));
}

/**
 * 在一段的过程里按边界线切开（#5381）：线当前一片的尾巴留在外面，线之后另起一片。
 * 最后一片接回原段的尾巴 —— 哪怕它的过程和尾巴都空着也要留：跨轮合并接的是末段，
 * 删了它，后面 agent 自发的 cycle 就接不到线的这一侧来了。
 */
function splitAtContextBoundaries(segment: TurnFoldSegment, clocked: boolean): TurnFoldSegment[] {
  const pieces: TurnFoldSegment[] = [];
  let process: ChatItem[] = [];
  let startedAt = segment.startedAt;
  for (const item of segment.process) {
    if (!staysOutside(item)) {
      process.push(item);
      continue;
    }
    pieces.push({ process, tail: [item], ...(startedAt !== undefined ? { startedAt } : {}) });
    process = [];
    startedAt = itemAt(item, clocked);
  }
  pieces.push({ process, tail: segment.tail, ...(startedAt !== undefined ? { startedAt } : {}) });
  return pieces;
}

/** 折叠段的深拷贝 —— 合并会就地往段里塞东西，❌ 别动到 `foldPlans` 里那一份。 */
function copySegments(segments: readonly TurnFoldSegment[]): TurnFoldSegment[] {
  return segments.map((segment) => ({
    process: [...segment.process],
    tail: [...segment.tail],
    ...(segment.startedAt !== undefined ? { startedAt: segment.startedAt } : {}),
  }));
}

/** 连续折叠合并出的一条:一个锚轮,加上被它吸收的后续轮(#4981)。 */
export type TurnFoldRun = {
  segments: TurnFoldSegment[];
  turnCount: number;
  endedAt: number | undefined;
  /** Only the last real turn outcome can confirm this merged run completed. */
  completed: boolean;
};

/**
 * 一层里每轮的折叠计划,与「连续折叠回合合并成一条」(#4981)。桌面 `flattenTier` 与手机会话页共用。
 *
 * 上游 `elements-tool-timeline` 的单位是「把**一个** assistant 回合做的全部事情收成
 * **一行**」。而 reducer 这一侧的「回合」是按 ACP 的 turn_end 切的：agent 自己发起的
 * 后续内容会各自开一个新回合（reducer.ts 的 lazy open），于是用户问一句可能落成十几
 * 个回合 —— 界面上就是十几行灰色的「过程 · 1 步」摞在一起，每一行都不说事
 * （owner 验收截图，2026-09-05：一屏 14 条）。
 *
 * 合并只在**两条之间什么都不夹**时发生：前一条没有尾巴（最终回复），后一条没有开头
 * （用户消息），且不跨天。夹了任何东西就必须断开 —— 否则会把内容搬到一条回复的另一
 * 侧去，读者看到的先后顺序就不是真的了。
 *
 * ⚠️ 正在跑的那一轮同样折（#4981 #12），判据只多一条：`live` 时最后一轮按 `planLiveTurnFold` 判
 * （开口后接着干活，那句话算过程）。owner 验收截图
 * （2026-09-05）里，一摞折好的头下面吊着两行没人认领的裸 `unknown` 工具行 —— 那就是
 * 活动层。上游 `elements-tool-timeline` 的 `streaming` 是这条时间线自己的一个 prop，
 * 它整轮都在，只是换个会微光的标签；它的示例里 `open` 初值就是 `false`，即**跑着的
 * 时候也是收起来的**。正在写的那条最终回复落在 `tail` 里，照旧在外面看得见。
 */
export function planTurnFoldRuns(
  turns: readonly TranscriptTurn[],
  prevDayKey: string | undefined,
  enabled: boolean,
  /**
   * 这一层的最后一轮正在跑(活动层):它按 `planLiveTurnFold` 判。只在这一层只有正在跑的那一轮时传(桌面活动层、
   * 手机的 live 层都是):agent 自己开头的一轮按它判会多出可折的过程,前面若还有一轮、末段没有尾巴,
   * 这一轮就会被当成「接得上」并进前一轮的头里(#129 review)。
   */
  live = false,
  /**
   * 对话布局:跑着的那一轮 agent 自己起的(后台跑完、定时、群投递)也给过程行,只写执行状态、用时和步数,
   * ❌ 一句话还没说就不折、行平铺在上一轮回复底下、只露出后台药丸(MBP 验收 #733)。见 `turnFoldView`。
   */
  headLiveAgentTurn = false
): { folds: (TurnFoldPlan | null)[]; runs: Map<number, TurnFoldRun>; absorbed: boolean[] } {
  const foldPlans = turns.map((turn, i) =>
    !enabled ? null : live && i === turns.length - 1 ? planLiveTurnFold(turn) : planTurnFold(turn)
  );
  /** 被前面的锚吸收掉的回合，主循环整个跳过。 */
  const absorbed = new Array<boolean>(turns.length).fill(false);
  /** 锚的合并结果，键是锚在 `turns` 里的下标。 */
  const foldRuns = new Map<number, TurnFoldRun>();
  {
    let anchor = -1;
    let dayCursor = prevDayKey;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const opensDay = turn.startedAt !== undefined && localDayKey(turn.startedAt) !== dayCursor;
      if (turn.startedAt !== undefined) dayCursor = localDayKey(turn.startedAt);
      const fold = foldPlans[i];
      if (!fold) {
        anchor = -1;
        continue;
      }
      const run = anchor >= 0 ? foldRuns.get(anchor) : undefined;
      // 接得上的是锚的**末段**：只有它还没有尾巴，后面的内容才不会被搬到一条回复的另一侧。
      const open = run?.segments[run.segments.length - 1];
      if (run && open && open.tail.length === 0 && fold.leading.length === 0 && !opensDay) {
        const [first, ...rest] = copySegments(fold.segments);
        open.process.push(...(first as TurnFoldSegment).process);
        open.tail = [...(first as TurnFoldSegment).tail];
        run.segments.push(...rest);
        run.turnCount += 1;
        // 并进来的这一段什么时候结束的,整条就什么时候结束 —— 时间头说的是从头到尾。
        run.endedAt = turn.endedAt;
        run.completed = turn.outcome?.kind === 'done';
        // 整个跳过是安全的：被吸收的回合按上面的条件不开新的一天；而折叠本身就要求
        // `!ctx.active`（不会有 working 行）与 outcome 为 done（不会有 turn-outcome 行），
        // 所以主循环里那三样它一样都产不出来。
        absorbed[i] = true;
        continue;
      }
      // agent 自己开头、一句话没说的一轮(只有完成通知、`[NO_REPLY]`)不折,也不当锚(#69):折起来外面
      // 只剩一个空头;当锚的话,下一次被叫醒的那一轮会并进来,头上的用时就把两次之间的空闲也算进去了。
      if (fold.leading.length === 0 && turn.initiator !== 'user' && !fold.spoke && !(headLiveAgentTurn && live && i === turns.length - 1)) {
        foldPlans[i] = null;
        anchor = -1;
        continue;
      }
      anchor = i;
      foldRuns.set(i, {
        segments: copySegments(fold.segments),
        turnCount: 1,
        endedAt: turn.endedAt,
        completed: turn.outcome?.kind === 'done',
      });
    }
  }
  return { folds: foldPlans, runs: foldRuns, absorbed };
}

/**
 * 一轮一轮往后追加时,`turns[index]` 会不会并进它前面那条还没收尾的折叠(上面的合并)。会的话,只 flatten
 * 新来的那几轮画不出这次合并 —— 调用方得整条重建;不然要等下次整条重建(切 tab、重进)那几行才跳进头里,
 * 「在聊天里找」(整条一次 flatten)打开的头也和画出来的对不上(#70 review)。
 */
export function joinsFoldRunAt(turns: readonly TranscriptTurn[], index: number, enabled: boolean): boolean {
  const first = turns[index];
  if (!enabled || !first || index === 0) return false;
  const opens = (turn: TranscriptTurn) => {
    const head = (turn.items as readonly ChatItem[])[0];
    return head !== undefined && itemIsUser(head);
  };
  // 带人话开头的一轮不会并进别人(并进来要求没有开场白),它自己起一条 —— 往回找到最近的那一轮就够了。
  if (opens(first)) return false;
  let start = index - 1;
  while (start > 0 && !opens(turns[start] as TranscriptTurn)) start--;
  let prevDayKey: string | undefined;
  for (let i = start - 1; i >= 0 && prevDayKey === undefined; i--) {
    const startedAt = turns[i]?.startedAt;
    if (startedAt !== undefined) prevDayKey = localDayKey(startedAt);
  }
  return planTurnFoldRuns(turns.slice(start, index + 1), prevDayKey, true).absorbed[index - start] === true;
}

/** 一段过程的时间头:和桌面 `turn-process` 行同一组事实。 */
export type TurnProcessHeader = { id: string; live: boolean; placeholder?: boolean; startedAt?: number; endedAt?: number };

/** Real results for the completion action bar when this run has no reply text. */
export function completedTurnResult(turn: TranscriptTurn, run: TurnFoldRun | undefined, active: boolean): string | null {
  if (turn.initiator !== 'user' || active || !(run ? run.completed : turn.outcome?.kind === 'done')) return null;
  const items = run ? run.segments.flatMap((segment) => [...segment.process, ...segment.tail]) : turn.items as readonly ChatItem[];
  let lastReply = -1;
  let lastCall = -1;
  items.forEach((item, index) => {
    const reply = isAssistantMessage(item);
    if (reply && replyText(item).trim().length > 0) lastReply = index;
    else if (item.kind === 'tool' || ('toolCallId' in item && item.kind !== 'subagent-done-tool-call')) lastCall = index;
  });
  if (lastReply >= 0 && lastReply > lastCall) return null;
  const text = items.flatMap((item) => {
    if (itemIsUser(item)) return [];
    if (item.kind === 'message') return isGuguSilence((item as ChatMessage).text) ? [] : [(item as ChatMessage).text.trim()];
    if (item.kind === 'thinking') return [(item as { text: string }).text];
    const title = 'title' in item ? item.title : 'name' in item ? item.name : '';
    const input = 'rawInput' in item && item.rawInput != null ? JSON.stringify(item.rawInput, null, 2) : '';
    const output = 'outputText' in item ? item.outputText : 'result' in item ? item.result : '';
    return [[title, input, output].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n')];
  }).filter(Boolean).join('\n\n');
  return text || null;
}

/** 头开着没有。开关记的是「点过没有」;跑着默认摊开,所以活动层把它反过来读。 */
export function turnProcessExpanded(live: boolean | undefined, toggled: boolean): boolean {
  return live ? !toggled : toggled;
}

/**
 * 一轮落成哪几段:每段的过程、收尾,以及过程上那颗时间头(`null` = 不画头,平铺)。
 * 桌面(`flattenTier`)与手机会话页逐段照着画。
 */
export function turnFoldView(
  turn: TranscriptTurn,
  fold: TurnFoldPlan,
  run: TurnFoldRun | undefined,
  active: boolean,
  /** 对话布局:跑着的 agent 自起轮也套头(见 `planTurnFoldRuns` 的 `headLiveAgentTurn`)。 */
  headLiveAgentTurn = false
): { leading: ChatItem[]; segments: { process: ChatItem[]; tail: ChatItem[]; header: TurnProcessHeader | null }[] } {
  // 这一条覆盖的全部过程行与最终的尾巴 —— 可能来自不止一个回合(见 `planTurnFoldRuns`)。
  const merged = run ?? { segments: copySegments(fold.segments), turnCount: 1, endedAt: turn.endedAt };
  // 人问的那一轮(含并进来的后续 cycle)有时间头。agent 自己开头的一轮(后台命令跑完、完成通知把它
  // 叫醒)跑完了同样折、只留最后一句话(#69,owner 2026-10-22,推翻 09-06「自发轮平铺,语义折叠就是它的
  // 折叠」:读的人分不出哪段是谁开的头,跑完了还摊着过程,看着就是同一问没折)。
  // 一句话没说的那种在 `planTurnFoldRuns` 里就不折了。跑着的时候不套头:它会不会开口还不知道,
  // 先给头、跑完一句没说再撤掉,那一行就白跳一下 —— 跑完再折,正是「跑完了就折起来」。
  const userRun = fold.leading.length > 0 || turn.initiator === 'user';
  // 对话布局例外:跑着就套头,过程行只写可观测的执行状态、用时和步数。主人手打的消息
  // 不能看着像被不是他发起的事挡住)。代价是跑完一句没说的那一轮(`[NO_REPLY]`)头会撤掉。
  const headed = userRun || (!active && fold.spoke) || (active && headLiveAgentTurn);
  return {
    leading: fold.leading,
    segments: merged.segments.map((segment, segIndex) => {
      if (!headed) return { process: segment.process, tail: segment.tail, header: null };
      // 时间头(owner 2026-09-06:「时间头本身算是过程的折叠,只不过是运行完成后,
      // 时间头是对过程的折叠」):跑着「已处理 16s」在数、内容摊开;跑完写总时长、把过程收起来。
      // 跑着的只有**最后一段** —— 前面那些已经被钩子封口了(#5350),所以按段判,不按轮判。
      // 每一段写**自己**那一段的用时(owner 2026-09-09 拍板):第一段 整轮起点 → 第一条钩子通知,
      // 中间段 上一条通知 → 下一条通知,末段 最后一条通知 → 整轮终点。任一端不知道就两格都不写,
      // 头退回「过程」—— ❌ 别拿整轮的读数去顶某一段,那是个会撒谎的计时器。
      const startedAt = segIndex === 0 ? turn.startedAt : segment.startedAt;
      const next = merged.segments[segIndex + 1];
      const endedAt = next ? next.startedAt : merged.endedAt;
      return {
        process: segment.process,
        tail: segment.tail,
        header: {
          id: turnProcessId(turn.id, segIndex),
          live: active && segIndex === merged.segments.length - 1,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
        },
      };
    }),
  };
}

/**
 * 跑着、这一段还没有可折的过程时,头先占着它的位置:写「正在思考…」、不数秒、没有箭头(下面没有可展开的东西,
 * ❌ 一个点了没反应的箭头)。agent 一开始干活(第一个工具 / 思考到了,见 `planLiveTurnFold`),
 * 同一个 id 的头接着写「已处理 Ns」。
 * owner 2026-10-23:「这个头不应该闪现,可以有个占位是正在思考」——
 * 从前 agent 先开口说一句、再去跑命令时,过程是空的,头被撤掉,第二句话到了又冒出来(真机:消失 13.7 s)。
 * 推翻 10-07「发出就在数「已处理 Ns」」:秒数跟着干活出现。
 */
export function placeholderTurnHeader(id: string): TurnProcessHeader {
  return { id, live: true, placeholder: true };
}

/**
 * 跑着、还没有可折的过程(`planTurnFold` 为 null)时这一轮的头 —— 占位(`placeholderTurnHeader`),
 * 插在 `at`(它前面有几条)。两种时候:
 * ① 这一轮里只有人说的话:上游首字节常常要几十秒(10-07 devdb 网关实测 5–61 s),那段时间里没有任何一层有
 *    thinking 可画 —— 不画这一头,消息下面就是空的,像是没发出去(owner 10-07)。占在人那句话之后,第一段的 id;
 * ② 人问的这一轮,agent 先开口说了一句、还没开始干活:那句话是收尾的候选,过程还是空的(owner 10-23)。
 *    占在**最后一段**那句话之前、用那一段的 id —— 前面有边界线(启动提示、提问、压缩)时,过程到了接手的是
 *    线后面那一段的头;占在别处、用别的 id,接手时头就换位置再冒出来一次(#124 review)。
 *    最后一段还什么都没有(在等人答提问、刚插了话、刚压缩完)就不占:那时 agent 没在想,❌ 一行「正在思考」在扫。
 * `folding` = 这一视图折不折过程。不折的视图(单栏)只有 ①:那里没有折叠头来接手,第一行内容一到占位就让位。
 * 桌面 `flattenTier` 与手机会话页共用这一条判断。
 */
export function pendingTurnHeader(
  turn: TranscriptTurn,
  active: boolean,
  folding = true
): { header: TurnProcessHeader; at: number } | null {
  if (!active) return null;
  const items = turn.items as readonly ChatItem[];
  let lead = 0;
  while (lead < items.length && itemIsUser(items[lead] as ChatItem)) lead++;
  if (lead === items.length) return { header: placeholderTurnHeader(turnProcessId(turn.id)), at: lead };
  if (!folding || !(lead > 0 || turn.initiator === 'user')) return null;
  const { segments } = segmentTurn(turn);
  const last = segments[segments.length - 1];
  if (!last || last.tail.length === 0) return null;
  return { header: placeholderTurnHeader(turnProcessId(turn.id, segments.length - 1)), at: items.indexOf(last.tail[0] as ChatItem) };
}

/**
 * 折叠头上那句话。跑着的时候「已处理 16s」在数,跑完了写「用时 42s」
 * (owner 2026-09-06:「结束后用用时来表达吧」);回放来的一轮两头没有时刻就只写「过程」——
 * 一个会少报的计时器比没有计时器更糟。
 */
export function turnProcessLabel(
  process: { live?: boolean; placeholder?: boolean; starting?: boolean; startedAt?: number; endedAt?: number },
  now: number,
  translate: (key: string, vars?: Record<string, string>) => string
): string {
  const { live, startedAt, endedAt } = process;
  if (live) {
    // 占位(还没有可折的过程)与「在跑、但这一段不知道从哪开始」是两件事,两句话(#124 review)。
    if (process.starting) return translate('transcript.starting');
    if (process.placeholder) return translate('transcript.turnPlaceholder');
    if (startedAt === undefined) return translate('transcript.working');
    return translate('transcript.turnElapsed', { elapsed: formatElapsed(Math.max(0, now - startedAt)) });
  }
  if (startedAt !== undefined && endedAt !== undefined) {
    return translate('transcript.turnTook', { elapsed: formatElapsed(Math.max(0, endedAt - startedAt)) });
  }
  return translate('transcript.turnProcess');
}
