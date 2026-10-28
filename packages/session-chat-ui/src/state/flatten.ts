import { conversationOutput, conversationProcessReply } from './conversation-process';
import { conversationMessages } from './conversation-messages';
import { withSentReplies } from './sent-replies';
/**
 * flatten — segment a transcript into a two-tier UnitsView.
 *
 * flattenTier() is the pure per-tier segmenter. ChatRoot calls it via two
 * tier-scoped createMemos:
 *
 *   committedUnits  — stable; recomputes only when committed() identity
 *                     changes (turn_done / prepend / seed). The framework memo
 *                     replaces the old WeakMap segmentCache.
 *   activeUnits     — recomputes per streaming tick but only over the small
 *                     activeTurn array. No O(total) work during streaming.
 *
 * The two tiers are joined into an UnitsView (virtual concat) that never
 * allocates a full array per tick. All downstream consumers use
 * UnitsView.at(i) / .length instead of direct array access.
 *
 * ── Seam gap ─────────────────────────────────────────────────────────────────
 *
 * The cross-tier boundary seam (last committed unit → first active unit) is
 * resolved by passing the last committed unit's kind as `prevKind` to
 * flattenTier when building activeUnits.
 *
 * ── Day boundary ─────────────────────────────────────────────────────────────
 *
 * A `day-separator` unit is emitted before the first turn of each new local
 * calendar day. It is a unit of its own (not a decoration on the message under
 * it) so that measurement and `scrollToItem` addressing both stay unchanged —
 * see the rationale on `day-separator.def.tsx`.
 *
 * The day context crosses tiers the same way `prevKind` does: `prevDayKey` in,
 * `trailingDayKey()` out. Without it the committed→active seam would re-announce
 * a day that is already on screen every time the user sends a message.
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 *
 * Segmenters must mint stable unit ids (${itemId}#${key}) so that the SolidJS
 * <For> over visible units never unnecessarily remounts rows, which would lose
 * the nodeMemo / blockMemo measure caches.
 *
 * ── Helpers ───────────────────────────────────────────────────────────────────
 *
 * flattenTier(items, ctx, segmenters, unitDefs?, prevKind?, prevDayKey?)
 *                               — pure; returns a RenderUnit[] for one tier.
 * trailingDayKey(turns, fallback?)
 *                               — the day context a tier hands to the next one.
 * UnitsView                     — virtual two-tier concat: .length / .at(i).
 * makeUnitsView(c, a)           — combine committedUnits + activeUnits.
 * collectUserTurnUnits(committed, units)
 *                               — absolute unit indices of the first unit of
 *                                 each committed user-message group; used by
 *                                 ChatRoot for the pinned-header overlay.
 */

import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { agentSendOf } from '@gugu/session-core/session-record/reply-process';
import { resolveSeamGap } from '@session-chat/core/spacing';
import type { FoldGate, ItemSegmenter, Margin, RenderUnit, SegmentCtx } from '@session-chat/core/units';
import { stampGroupRoles } from '@session-chat/core/units';
import { localDayKey } from '@session-chat/lib/day-boundary';
import type { ChatItem, ChatMessage, SyntheticItem, TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { fileChangeSummary, successfulFileDiff } from '@session-chat/state/file-change-summary';
import { collectOpenedOutputs, openedOutputKey, outputsOfRun } from '@session-chat/state/opened-outputs';
import { tallyToolRun, toolRunCategory, toolRunLabel, toolRunNow } from '@session-chat/state/tool-run';
import { completedTurnResult, itemIsUser, pendingTurnHeader, placeholderTurnHeader, planTurnFoldRuns, turnFoldView, turnProcessExpanded } from '@session-chat/state/turn-fold';

export { planTurnFold, turnProcessId } from '@session-chat/state/turn-fold';
export type { TurnFoldPlan, TurnFoldSegment } from '@session-chat/state/turn-fold';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * 这条是别的 agent 投递进来的，不是这里的人打的字（#4981）。
 *
 * owner 2026-09-06:「别的 agent 给这个 agent 发的信息其实也是通知，也不应该计入消息，
 * 更不应该有 stick 效果」。⇒ 它照旧显示（投递卡），但**不占「人刚发言」那个身份**：
 * 不被钉到顶端、不触发底部预留把视图拽过去、「取回指令」也不会把别人的话塞进你的输入框。
 * 判据是 core 的 `isDeliveryEnvelope`：以信封开头的都算，读方一时读不出的那条也不冒充人说的话。
 */
export function isDeliveredFromAgent(item: ChatItem): boolean {
  if (item.kind !== 'message' || (item as ChatMessage).role !== 'user') return false;
  return isDeliveryEnvelope((item as ChatMessage).text);
}


/**
 * 这一轮的原始用户指令，给 turn-outcome 行的「取回指令」用。
 *
 * 只认 `initiator === 'user'` 的 turn：agent 自己发起的后台 turn 里也可能出现 role=user 的
 * 条目（工具回灌的合成消息），把那种东西塞回输入框会让用户看到一条自己没写过的指令。
 * 取**第一条**而不是最后一条：一个 turn 的开场白才是它在跑的那条指令。
 */
function turnPromptText(turn: TranscriptTurn): string | undefined {
  if (turn.initiator !== 'user') return undefined;
  for (const item of turn.items as readonly ChatItem[]) {
    if (!itemIsUser(item)) continue;
    // 别的 agent 投递进来的那条不是「你写的指令」—— 塞回输入框等于让你重发别人的话。
    if (isDeliveredFromAgent(item)) continue;
    const text = (item as ChatMessage).text.trim();
    if (text) return text;
  }
  return undefined;
}

/** 过程行排好之后的一个单元:一行原样,或一段连续工具调用折成的一句。 */
type EmitOp = { kind: 'row'; item: ChatItem } | { kind: 'run'; rows: ChatItem[] };

// ── ItemNode ──────────────────────────────────────────────────────────────────

/** A node in a nested tool-call render tree. */
export type ItemNode = {
  item: ChatItem;
  children: ItemNode[];
};


// ── flattenTier ───────────────────────────────────────────────────────────────

/**
 * Segment one tier (committed or activeTurn) into a flat RenderUnit[].
 *
 * `prevKind` is the kind of the last unit from the preceding tier (if any).
 * It is used to resolve the gapBefore of the first unit in this tier against
 * the cross-tier boundary seam. Omit for the committed tier (it is always
 * first).
 */
/**
 * 这一条是某个子智能体自己跑的调用吗 —— 是的话 ❌ 不进主消息列表。
 *
 * owner 2026-09-05:「子调用我不应该在主消息列表看到,应该在子智能体那里看到才对」。
 * 它归那个子智能体,读者在「输出/来源」面板它自己那张卡上看(悬浮出时间线)。
 *
 * 判据就是 `parentToolCallId` 本身:解码器给每条调用写死 null,**只有** claude 那侧的
 * `_meta.claudeCode.parentToolUseId` 会把它填上,而那个字段的语义只有一个 ——
 * 「这条调用是某个子智能体跑的」。⇒ 非空即子调用,不必再另外认爹。
 *
 * ⚠️ 必须在渲染这一层拦,不能只靠「挂到爹下面就不单独成行」:后台派出去的子智能体
 * **跨轮**才回来,拼树是按「同一轮里找爹」的,跨轮找不着就掉回顶层平铺 —— owner 截图里
 * 那一整面「获取 / 工具」的墙就是这么来的。
 *
 * ⚠️ **凡是按这条藏起来的,计数里也不能有**(见下面 `visibleProcess`)。少了这一条,
 * 折叠头会报一个「17 步」而底下只画得出 6 行,甚至报「18 步」而一行都没有 ——
 * owner 2026-09-06 原话:「没有步骤的步骤」。
 */
function isSubagentChild(item: ChatItem | SyntheticItem): boolean {
  return 'parentToolCallId' in item && Boolean(item.parentToolCallId);
}

export function flattenTier(
  turns: readonly TranscriptTurn[],
  ctx: SegmentCtx,
  segmenters: Record<string, ItemSegmenter>,
  unitDefs?: Record<string, { margin?: Margin }>,
  prevKind?: string,
  prevDayKey?: string
): RenderUnit[] {
  turns = turns.map(turn => withSentReplies(turn, { allDestinations: ctx.agentConversation }));
  if (ctx.agentConversation) turns = conversationMessages(turns);
  const out: RenderUnit[] = [];

  // Hoist stable per-call values so processItem allocates nothing per seam.
  const marginOf = (k: string) => unitDefs?.[k]?.margin;

  // Track the kind of the last emitted unit for seam resolution.
  let lastKind = prevKind;
  // The calendar day the units emitted so far belong to. Seeded from the
  // preceding tier so the committed→active seam does not re-announce a day that
  // is already on screen.
  let lastDayKey = prevDayKey;

  const processItem = (item: ChatItem | SyntheticItem, folds?: readonly FoldGate[]): void => {
    if (isSubagentChild(item)) return;
    const seg = segmenters[item.kind];
    if (!seg) return;
    const group = seg.segment(item, ctx);
    const chrome = seg.chrome;

    stampGroupRoles(group);
    if (group.length === 0) return;
    if (ctx.revealAllFolds && folds) for (const u of group) u.folds = folds;

    // Copy chrome from the segmenter onto each unit (allows UnitRow to read it
    // without looking up the segmenter). The chrome value is stable (segmenter
    // is module-level, not data-dependent).
    if (chrome) {
      for (const u of group) {
        u.chrome = chrome;
      }
    }

    // Resolve the inter-group gap and assign it to the first unit of each
    // group (except the very first group overall, which gets gapBefore = 0).
    if (lastKind !== undefined) {
      group[0].gapBefore = resolveSeamGap(lastKind, group[0].kind, marginOf);
    }

    lastKind = group[group.length - 1].kind;
    out.push(...group);
  };

  /** 正在发的这一轮:agent 说出去的话发到哪,要看它当时在回哪一条投递(`agentSendOf`)。 */
  let sendTurn: TranscriptTurn | undefined;

  /**
   * 把一串过程行排成要发出的单元：**连续的工具调用**折成一句（#4981，owner 2026-09-06：
   * 「连续的 tool call 可以被折叠……除了 ai 文本以外都语义化折叠」）。分类与切段规则在
   * `state/tool-run.ts`。两条起折；一条就是一行。子调用不进列表（见 isSubagentChild），
   * 也不算进这一句。
   *
   * 先排后发，是因为「排完剩几行」本身就是一个判据：只剩一行时外面不再套时间头
   * （owner：「过程一步可不需要折叠」「这就已经算折叠了」）。
   */
  const planRows = (rows: readonly ChatItem[]): EmitOp[] => {
    const ops: EmitOp[] = [];
    let run: ChatItem[] = [];
    const flush = (): void => {
      if (run.length === 1) ops.push({ kind: 'row', item: run[0] });
      else if (run.length > 1) ops.push({ kind: 'run', rows: run });
      run = [];
    };
    for (const row of rows) {
      if (isSubagentChild(row)) continue;
      if (toolRunCategory(row)) {
        run.push(row);
        continue;
      }
      flush();
      ops.push({ kind: 'row', item: row });
    }
    flush();
    return ops;
  };

  /** 发出排好的单元。一句折叠展开(同一把 ViewState 开关)时在摘要行下面还原成原始行。 */
  const emitOps = (ops: readonly EmitOp[], turnId: string, folds: readonly FoldGate[] = []): void => {
    for (const op of ops) {
      if (op.kind === 'row') {
        // agent 经 message_send / session_message 说的话:画成它说的话、标明发到了哪里,❌ 一行「调用了 MCP 工具」。
        const send = 'toolCallId' in op.item ? agentSendOf(op.item as TranscriptItem, sendTurn) : null;
        processItem(send
          ? { kind: 'agent-send', id: op.item.id, turnId, send, status: (op.item as { status?: string }).status === 'running' ? 'running' : 'done' }
          : op.item, folds);
        continue;
      }
      const runId = toolRunId(turnId, op.rows[0].id);
      const live =
        ctx.active &&
        // 正在跑的工具是 `running`,正在想的思考是 `thinking`(#7316 起思考也进这一句)。
        op.rows.some((row) => {
          const status = 'status' in row ? (row as { status?: string }).status : undefined;
          return status === 'running' || (row.kind === 'thinking' && status === 'thinking');
        });
      // 跑着时这一句只说做了多少;此刻在跑哪条命令 / 在想,接在后面(`toolRunNow`),跑完自然恢复原样。
      const now = live ? toolRunNow(op.rows) : null;
      processItem({
        kind: 'tool-run',
        id: runId,
        turnId,
        label: toolRunLabel(tallyToolRun(op.rows), ctx.translate),
        stepCount: op.rows.length,
        ...(live ? { live: true as const } : {}),
        ...(now ? { now } : {}),
      }, folds);
      if (ctx.revealAllFolds || (ctx.isTurnProcessExpanded?.(runId) ?? false)) {
        for (const row of op.rows) processItem(row, [...folds, { id: runId, stored: true }]);
      }
    }
  };

  // 每轮的条目拷一份 —— 下面的折叠合并要在上面挪东西。
  // (这里曾有一段「把被回合边界劈成两半的同一句话缝回去」:那是给 250 ms 静默收轮的
  //  症状打的补丁。轮的边界改成真信号后(session-runtime cell.ts `isAgentCycleEnd`),
  //  句子不再被劈,补丁随之拆除 —— ❌ 守卫的对象没了、守卫还在。)
  // agent 打开给人看的文件 / 网页(#7193):那一步只在折起来的过程里作为一行出现(工作记录),
  // 别处(不折的一轮、回复之后的尾巴、手机上只画卡的那一块)由最后那张卡代表它,❌ 同一件事画两遍。
  // 还在跑的那一轮不挂卡(#7305,判据见 collectOpenedOutputs),那一步也就不藏,照普通工具调用显示。
  const opened = collectOpenedOutputs(turns, { live: ctx.active });
  const openSteps = new Set<ChatItem>(opened.flat().map((entry) => entry.item));
  const outsideProcess = (rows: readonly ChatItem[]) => rows.filter((item) => !openSteps.has(item) && (ctx.active || !successfulFileDiff(item)));
  const turnItems: ChatItem[][] = turns.map((turn) => [...(turn.items as readonly ChatItem[])]);

  // 连续折叠回合合并成一条(#4981),判据在 `planTurnFoldRuns`。
  const { folds: foldPlans, runs: foldRuns, absorbed } = planTurnFoldRuns(
    turns.map((turn, i) => ({ ...turn, items: turnItems[i] }) as TranscriptTurn),
    prevDayKey,
    ctx.foldTurnProcess === true,
    ctx.active
  );

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    if (absorbed[turnIndex]) continue;
    sendTurn = turn as TranscriptTurn;
    // Day boundary (#3334 row 20). A turn with no `startedAt` came from provider
    // replay and carries no authentic clock, so it neither opens a new day nor
    // closes the current one — it is simply not evidence about the calendar.
    if (turn.startedAt !== undefined) {
      const dayKey = localDayKey(turn.startedAt);
      if (dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        processItem({
          kind: 'day-separator',
          id: `${turn.id}:day`,
          startedAt: turn.startedAt,
        });
      }
    }

    const items = turnItems[turnIndex] as readonly ChatItem[];

    /**
     * 「丢弃」过的那一轮：只留用户那条指令，agent 写到一半的输出与收尾行都不再发出。
     * 上游 stopped-run 的 Discard 删掉的正是那条被取消的助手消息 —— 用户自己说过的话不该被它带走。
     * 判定条件里带上 `cancelled`：这个开关只由被停止那一行给得出来，读到别的收尾态说明 id 撞了，
     * 那种情况下宁可什么都不做，也不要静默吞掉一轮出错的记录。
     *
     * ⚠️ 这一支必须排在取 `foldPlans` 之前，但两边其实撞不上：`planTurnFold` 对
     * 非 `done` 的收尾态一律返回 null，所以被丢弃的那一轮既折不起来、也不会被前一个锚吸收。
     */
    if (!ctx.active && turn.outcome?.kind === 'cancelled' && ctx.isTurnDiscarded?.(turn.id)) {
      let leadEnd = 0;
      while (leadEnd < items.length && itemIsUser(items[leadEnd])) leadEnd++;
      for (let i = 0; i < leadEnd; i++) processItem(items[i]);
      continue;
    }

    const fold = foldPlans[turnIndex];
    if (fold) {
      const view = turnFoldView(turn, fold, foldRuns.get(turnIndex), ctx.active);
      for (const item of view.leading) processItem(item);
      for (const segment of view.segments) {
        // 先按语义折一遍,再看**剩几行**(owner 2026-09-06 截图:「过程 · 2 步」底下只有一句
        // 「2 个子智能体跑完了」—— 折叠套折叠;「过程 · 1 步」—— 一步也套了头)。
        const header = segment.header;
        // 不套头的那一段是平铺在外面的,和不折的一轮一样先剔掉别处已经画了的(卡片 / 改动汇总,#70 review)。
        const output = ctx.agentConversation && header ? conversationOutput([...segment.process, ...segment.tail]) : null;
        const footerReply = output?.reply ? conversationProcessReply(header, [output.reply]) : null;
        if (footerReply && header && output) {
          processItem(footerReply);
          const expanded = ctx.revealAllFolds || turnProcessExpanded(header.live, ctx.isTurnProcessExpanded?.(header.id) ?? false);
          if (expanded) emitOps(planRows(outsideProcess(output.rest)), turn.id, [{ id: header.id, stored: !header.live }]);
          continue;
        }
        const ops = planRows(header ? segment.process : outsideProcess(segment.process));
        if (ops.length === 0 || !header) {
          // 一条都不剩就连头都不画 —— ❌ 别留一个点开是空的壳。
          // 跑着的那一段例外:agent 先说了一句、还没开始干活,过程还空着 —— 头占着位置等过程,❌ 撤掉再冒出来
          // (`placeholderTurnHeader`)。那句话就在它下面,头不带微光(见 `withBody`)。这一段还什么都没有
          // (在等人答提问、刚插了话)就不占:那时 agent 没在想(#124 review)。
          if (header?.live && segment.tail.length > 0) {
            processItem({
              kind: 'turn-process',
              ...placeholderTurnHeader(header.id),
              ...(ctx.agentConversation && header.startedAt !== undefined ? { startedAt: header.startedAt } : {}),
              turnId: turn.id,
              withBody: true,
            });
          }
          emitOps(ops, turn.id);
        } else {
          const expanded = ctx.revealAllFolds || turnProcessExpanded(header.live, ctx.isTurnProcessExpanded?.(header.id) ?? false);
          processItem({
            kind: 'turn-process',
            id: header.id,
            turnId: turn.id,
            ...(header.live ? { live: true as const } : {}),
            // 收起来时下面什么都看不见,头又是这一轮唯一的动静(#124 review)
            ...(expanded ? { withBody: true } : {}),
            ...(header.startedAt !== undefined ? { startedAt: header.startedAt } : {}),
            ...(header.endedAt !== undefined ? { endedAt: header.endedAt } : {}),
          });
          // 头里面照样按语义折成「跑了 N 条命令」,跑着时自己摊开的、跑完后人点开的都一样(owner 2026-10-16,
          // 推翻 10-02「点开就逐条摆」:跑着时「执行、执行、执行、执行」一直平铺)。只在头里摊平的话,同一轮里还会
          // 自相矛盾:最后一句话之前的平铺、之后的(尾巴,头外面)折着,agent 一开口,折好的那几行就摊开。
          if (expanded) emitOps(ops, turn.id, [{ id: header.id, stored: !header.live }]);
        }
        emitOps(planRows(outsideProcess(segment.tail)), turn.id);
      }
    } else {
      // 跑着、还没有可折的过程:头占位,插在人那句话之后(判断与手机会话页同一份,见 `pendingTurnHeader`)。
      // 不折叠的视图(单栏)只在一轮还什么都没有时画:那时它是这一轮唯一的动静,第一行内容一到就让位。
      const pending = pendingTurnHeader(turns[turnIndex] as TranscriptTurn, ctx.active, ctx.foldTurnProcess === true);
      if (pending) {
        emitOps(planRows(outsideProcess(items.slice(0, pending.at))), turn.id);
        const pendingReply = ctx.agentConversation
          ? conversationProcessReply({ ...pending.header, startedAt: turn.startedAt }, items.slice(pending.at)) : null;
        if (pendingReply) {
          processItem(pendingReply);
          emitOps(planRows(outsideProcess(items.slice(pending.at + 1))), turn.id);
        } else {
          processItem({
            kind: 'turn-process',
            ...pending.header,
            ...(ctx.agentConversation && turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
            turnId: turn.id,
            ...(pending.at < items.length ? { withBody: true } : {}),
          });
          emitOps(planRows(outsideProcess(items.slice(pending.at))), turn.id);
        }
      } else {
        emitOps(planRows(outsideProcess(items)), turn.id);
      }
    }

    if (!ctx.active) {
      let runEnd = turnIndex + 1;
      while (runEnd < turns.length && absorbed[runEnd]) runEnd++;
      const summary = fileChangeSummary(turns.slice(turnIndex, runEnd), turn.id, ctx.caches.computeDiff);
      if (summary) processItem(summary);
    }

    // 这一轮交出来的东西(含被它并进来的后续轮):最后那条回复下面,一份一张卡。
    const outputs = outputsOfRun(opened, turnIndex, absorbed);
    outputs.forEach(({ output }, index) => {
      processItem({
        kind: 'opened-output',
        id: `${turn.id}:output:${openedOutputKey(output)}`,
        turnId: turn.id,
        output,
        index,
        count: outputs.length,
      });
    });

    const completionResult = completedTurnResult(turn, foldRuns.get(turnIndex), ctx.active);
    if (completionResult !== null) {
      processItem({ kind: 'turn-completion', id: `${turn.id}:completion`, turnId: turn.id, text: completionResult });
    }

    if (!ctx.active && turn.outcome && turn.outcome.kind !== 'done') {
      const prompt = turnPromptText(turn);
      processItem({
        kind: 'turn-outcome',
        id: `${turn.id}:outcome`,
        turnId: turn.id,
        outcome: turn.outcome,
        ...(prompt ? { prompt } : {}),
      });
    }
  }

  // 还在跑的后台任务 —— 同样只在 active 档发,贴在列表末尾(在「此刻的状态」那一行之上:
  // 会话出了状况时,最后一句该是那句状况)。
  const background = ctx.active ? ctx.backgroundTasks?.() : null;
  if (background) {
    processItem({
      kind: 'background-tasks',
      // 只有一行,id 不随条目变:单子里多一条、少一条都是同一行在长短,❌ 换一行重挂。
      id: BACKGROUND_TASKS_ID,
      commands: background.commands,
      subagents: background.subagents,
      expanded: background.expanded,
    });
  }

  // 这条会话此刻的状态 —— 贴在整个列表**最后一行**（spec `session-always-openable`）。
  //
  // ⚠️ 只在 active 档发：那是最后一档，发在 committed 档会把它埋进历史中间。
  // ⚠️ 它不进转录条目，所以条件一消失这一行就消失 —— 装好引擎之后不会留下一句「没装」。
  const condition = ctx.active ? ctx.condition?.() : null;
  if (condition) {
    processItem({
      kind: 'session-condition',
      // id 只按 code 走:同一种条件反复写入(重连风暴)落回同一行,❌ 不每次新增一条。
      id: `session-condition:${condition.code}`,
      ...condition,
      // prevKind covers the committed tier; out covers the active tier. A saved
      // provider session reference alone does not mean any history is visible.
      hasVisibleHistory: prevKind !== undefined || out.length > 0,
    });
  }

  return out;
}


/** 一段连续工具调用的摘要行 id：锚在段首那一行上（段首不变，展开状态就跟着不丢）。 */
export function toolRunId(turnId: string, firstItemId: string): string {
  return `${turnId}:run:${firstItemId}`;
}

/**
 * 「丢弃」这一轮的 per-id 开关的 id。
 *
 * 与 `turnProcessId` 一样，它挂在**同一套**视图状态上（`viewState().isCollapsed`），
 * 只是换一个后缀分开命名空间 —— 于是收尾行那颗按钮只要带上 `data-collapse-id`，
 * 走的就是 ChatRoot 里既有的那条点击委派，不必再开一条通路，也不必让宿主接一个回调。
 */
/** 列表末尾那一行后台任务的 unit id。 */
export const BACKGROUND_TASKS_ID = 'background-tasks';
/** 那一行单子展开 / 收起的开关 id(走 ChatRoot 既有的 `data-collapse-id` 点击委派)。 */
export const BACKGROUND_TASKS_TOGGLE = `${BACKGROUND_TASKS_ID}:open`;

export function turnDiscardedId(turnId: string): string {
  return `${turnId}:discarded`;
}

/**
 * 「这一轮失败的原文详情」展开开关的 id(#5858)。
 *
 * 与 `turnDiscardedId` 同一套视图状态、只换一个后缀分命名空间 —— 于是收尾行那颗「详情」
 * 只要带上 `data-collapse-id`,走的就是 ChatRoot 里既有的那条点击委派,❌ 不新开通路、
 * 也不必让宿主接一个回调。它同时是 `measure()` 里 `ctx.expanded(id)` 读的那个 id:
 * **量高度与画内容读的是同一个开关**,否则行会长成一个高度与内容对不上的框。
 */
export function turnOutcomeDetailId(turnId: string): string {
  return `${turnId}:outcome-detail`;
}


// ── UnitsView ─────────────────────────────────────────────────────────────────

/**
 * Virtual two-tier concatenation of committedUnits + activeUnits.
 *
 * Never allocates a combined array — .at(i) routes by offset. ChatRoot
 * creates one per frame via makeUnitsView(committedUnits(), activeUnits()).
 */
export type UnitsView = {
  readonly length: number;
  at(i: number): RenderUnit | undefined;
};

// ── trailingDayKey ────────────────────────────────────────────────────────────

/**
 * The calendar day a tier ends on — i.e. what its successor should be seeded
 * with as `prevDayKey`.
 *
 * Walks back to the last turn that actually knows when it happened. `fallback`
 * (the day the tier *started* on) is returned when none of these turns carry a
 * clock, because a tier of replayed turns leaves the day context exactly as it
 * found it — it is silence, not a new day.
 */
export function trailingDayKey(
  turns: readonly TranscriptTurn[],
  fallback?: string
): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const startedAt = turns[i].startedAt;
    if (startedAt !== undefined) return localDayKey(startedAt);
  }
  return fallback;
}

/** Combine two flat arrays into an UnitsView without allocating a concat. */
export function makeUnitsView(committed: RenderUnit[], active: RenderUnit[]): UnitsView {
  const cl = committed.length;
  return {
    length: cl + active.length,
    at(i) {
      return i < cl ? committed[i] : active[i - cl];
    },
  };
}

// ── collectUserTurnUnits ──────────────────────────────────────────────────────

/**
 * Returns the unit indices (in `units`) of the *first unit* of each user
 * message in `turns`, in ascending order.
 *
 * ChatRoot's pin anchors (@@@sticky-user-lanes): called once per tier — the
 * committed turns, and the active tier's one turn. Either tier can hold several
 * user messages per turn (an inserted message joins the running turn).
 */
export function collectUserTurnUnits(
  turns: readonly TranscriptTurn[],
  units: UnitsView
): number[] {
  const userItemIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      // 投递进来的通知不进这个集合 —— 这个集合就是「钉到顶端」的名单。
      if (itemIsUser(item) && !isDeliveredFromAgent(item)) userItemIds.add(item.id);
    }
  }

  if (userItemIds.size === 0) return [];

  // Walk the flat unit view once, recording the first unit index per group.
  const result: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    const u = units.at(i);
    if (u && userItemIds.has(u.itemId) && !seen.has(u.itemId)) {
      seen.add(u.itemId);
      result.push(i);
    }
  }
  return result;
}
