import type { ToolNode, TranscriptItem, TranscriptTurn } from './../model';

/**
 * 还没回话的子智能体花名册(#4981)。
 *
 * # 它读的是**登记册**,不是转录行
 *
 * owner 2026-09-06:「这里不该是个运行中,因为再去把运行中的组件在合适的时候去更新状态到
 * 完成是有点难的,这里就是创建智能体,然后后面就是智能体运行完在一条消息,其实无非是
 * toolcall 和 notification,这样工具调用的渲染才能统一」。
 *
 * ⇒ 转录里那一行是「启动子智能体」这次**调用**,它在启动返回的那一刻就完成了,和别的
 * 工具调用长一个样、不需要谁记得回头去落定它。而「那个智能体跑没跑完」是另一件事,
 * 记在 agents 登记册里(`updateAgentSlice`),只被真信号推动:完成通知(`<task-notification>`)
 * 或 SessionOutput 收割。**这两个状态不许再混成一个** —— 先前混着的后果 owner 截图里全在:
 * 一行永远写着「运行中」、失败重派之后旧卡撤不掉、面板上三个变六个。
 *
 * 位置与其余口径(owner 2026-09-05 / 09-06 定):
 *   · 上游那个 `elements-subagent-list` 放在「输出/来源」面板里,不放进转录;
 *   · 卡上收到完成通知就撤 —— ❌ 不是「跑完即移除」那种要我们自己判的完成;
 *   · 它具体调了哪些工具只在悬浮面板里看得到(子调用不进主消息列表)。
 *
 * ⚠️ **子智能体 ≠ 会话 agent,这两个不许混。** 产品自己划的界(capability-bundle):
 *   · `session_spawn` 起的是**咕咕的真成员**:有身份、有联系人条目、别人能找它,
 *     **活过这一轮**;它在左侧任务树里已经有位置,❌ 不进这份名册。
 *   · harness 的子智能体这些都没有,**随这一轮死** —— 所以它跑完就该从面板上消失,
 *     留着就是占位。
 * 一次真机回合里两种同时出现过,名字还只差一个字(会话 agent「江苏天气」/
 * 子智能体「查询江苏天气」),摆在一屏上人是分不出来的 —— 这正是 owner 说
 * 「你好像也没分清」的那一幕。
 *
 * ⚠️ 它要是再也不回话,卡就一直挂着 —— 那是**如实**说「它没回来过」,而替它宣布一个
 * 没发生的结局是编。人可以按悬浮面板里那颗 × 手动收起(owner 2026-09-06 定)。
 */
export type SubagentRosterEntry = {
  /** 转录条目 id —— 面板里做 key 用,同一次派发跨轮也不会变。 */
  id: string;
  /** 派它出去的那次调用的 tool_use id —— 停它时报给供应商的就是这个(#5117)。 */
  launchToolCallId: string;
  /** 派它去做什么。拿不到才退到通用词(调用方给),❌ 不编。 */
  name: string;
  /** 它实际跑在哪个模型上;拿不到就不画这一格。 */
  model?: string;
  /** 它自己已经跑完的工具调用数 —— 进度那一格的原始读数。 */
  completedSteps: number;
  /**
   * 它自己跑过的**全部**调用,按时序。悬浮在它身上时展开成一条时间线
   * (owner 2026-09-06:「悬浮上去,出来进度面板啊…用 tool-timeline 展示他的进度,
   * 可以滚动轴如果太长的话」)。
   *
   * ⚠️ 这些**不**在主消息列表里出现 —— 它们归这个子智能体,只在这儿看得到。
   */
  calls: readonly SubagentCall[];
  /** 派出去到现在过了多久(毫秒);拿不到起点时是 0。 */
  elapsedMs: number;
  canCancel?: boolean;
};

function isSubagent(item: ToolNode): item is Extract<ToolNode, { kind: 'spawn-subagent-tool-call' }> {
  return item.kind === 'spawn-subagent-tool-call';
}

/**
 * 这个子智能体自己跑的那些调用。
 *
 * ⚠️ **不能只看它 `children` 里挂着的那些。** 拼树是按「同一轮里找爹」办的,而后台派
 * 出去的子智能体**跨轮**才回来 —— 它那几条调用于是落在后面某一轮的顶层,爹在前一轮。
 * 只数 `children` 的话,恰恰把最常见的那种(后台派发)数成 0。
 * ⇒ 这里改成扫**所有轮**,按 `parentToolCallId` 认爹。
 *
 * ⚠️ 数的是**有 `toolCallId` 的那些**,也就是叶子:连续的文件读取会被 `read-batch`
 * 收成一个 `tool-group`,那层壳是排版不是调用,它没有 `toolCallId`,自然不计数。
 */
export type SubagentCall = {
  toolCallId: string;
  /** 供应商给这次调用起的名字。拿不到就是空串 —— ❌ 不编。 */
  title: string;
  status: ToolNode['status'];
  seq: number;
};

function collectCalls(
  items: readonly TranscriptItem[] | readonly ToolNode[],
  out: Map<string, Map<string, SubagentCall>>
): void {
  for (const item of items as readonly ToolNode[]) {
    // ⚠️ `tool-group`(read-batch 那层壳)这三样都没有 —— 它是排版不是调用,
    // 正好该被这几个 `in` 挡在外面,所以这里不是为了迁就类型。
    const parent = 'parentToolCallId' in item ? item.parentToolCallId : undefined;
    const callId = 'toolCallId' in item ? item.toolCallId : undefined;
    if (parent && callId) {
      const byId = out.get(parent) ?? new Map<string, SubagentCall>();
      // 同一次调用会来好几条事件 ⇒ 按它自己的 toolCallId 去重,后到的覆盖先到的。
      byId.set(callId, {
        toolCallId: callId,
        title: ('title' in item ? item.title : undefined) ?? '',
        status: item.status,
        seq: item.seq,
      });
      out.set(parent, byId);
    }
    const children = 'children' in item && item.children ? item.children : undefined;
    if (children) collectCalls(children, out);
  }
}

/**
 * 把树里所有派发调用捞出来(是不是顶层由调用方再筛)。
 *
 * ⚠️ 往下走是为了**找得到**那些嵌在 `tool-group` 之类壳里的条目,❌ 不是为了把下一层
 * 也收进名册 —— 那一条先前写反过:注释曾是「子智能体可以自己再派子智能体,漏了下层
 * 名册就少人」,结果 owner 2026-09-06 派三个、面板上出来九张。多出来的六张正是
 * 「调研澳门」自己再派的那六个,它们已经在它爹的时间线里了。
 */
function walk(items: readonly TranscriptItem[] | readonly ToolNode[], out: ToolNode[]): void {
  for (const item of items as readonly ToolNode[]) {
    if (isSubagent(item)) out.push(item);
    const children = 'children' in item && item.children ? item.children : undefined;
    if (children) walk(children, out);
  }
}

/**
 * 收出**还没回话的**那些。`fallbackName` 是一个字都没给时的通用词。
 *
 * 判据是纯派生的,全部来自同一份转录 —— ❌ 没有任何需要有人记得去维护的活状态。
 *
 * ⚠️ **后台派发与同步派发的收场信号不是同一个**,这两支必须分开判:
 *
 *   · 后台的(`background`):启动返回 ≠ 它干完了。等那条完成通知
 *     (转录里的「子智能体已完成」那一行,按 `launchToolCallId` 对上)。
 *   · 同步的:没有通知这一说 —— **它那次调用完成就是它干完了**。
 *     混在一起判的话,同步派出去的那些会永远挂在面板上,因为它们等的那条通知根本不会来。
 *
 * 名册只收**顶层**派发:子智能体自己再派的那一层归它爹管,在它爹的时间线里看得到。
 *
 * 两支都还要再减掉**启动本身就失败的**。owner 2026-09-06 截图里那张永远转着的
 * 「调研南昌」正是它:子智能体验证失败、派发当场就没成,于是它永远等不到任何通知 ——
 * 不减这一项,它会一直挂着,而 agent 已经重派了一次,面板上就变成两张。
 */
export function collectSubagentRoster(
  turns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  fallbackName: string,
  /** 现在几点 —— 显式传进来,判据才好钉住时间那一路(❌ 别在函数里读墙钟)。 */
  now: number = Date.now()
): SubagentRosterEntry[] {
  const found: ToolNode[] = [];
  const callsByParent = new Map<string, Map<string, SubagentCall>>();
  const notified = new Set<string>();
  /**
   * 从**重放**里来的派发(所在的一轮没有 `startedAt` —— reducer 只给活着的会话盖时刻)。
   *
   * 重开会话时 `claude --resume` 起的是一个新进程,上一个进程里的后台子智能体不会跟过来,
   * 也没有接口能去问它们(2026-09-06 实测:resume 启动只吐两条 hook 事件;SDK 0.3.197
   * 没有「列在跑的任务」的请求)。所以重放里的后台派发到重放结束时若还没等到通知,它已经
   * 不在跑了 —— 不判成败,只是不再当「在跑」(owner 2026-09-06)。
   * ❌ 不是 replay 里的照旧等通知:活着的会话里派出去的,等的那条通知真的会来。
   */
  const replayed = new Set<string>();
  const scan = (items: readonly TranscriptItem[], fromReplay: boolean): void => {
    const before = found.length;
    walk(items, found);
    if (fromReplay) {
      for (let i = before; i < found.length; i++) {
        const node = found[i];
        if (isSubagent(node)) replayed.add(node.toolCallId);
      }
    }
    collectCalls(items, callsByParent);
    collectNotified(items, notified);
  };
  for (const turn of turns) scan(turn.items, turn.startedAt === undefined);
  if (activeTurn) scan(activeTurn.items, activeTurn.startedAt === undefined);

  const byCallId = new Map<string, SubagentRosterEntry>();
  for (const item of found) {
    if (!isSubagent(item)) continue;
    // ⚠️ 只收**顶层**派发。子智能体自己再派的那一层归它爹管 —— 它已经作为一条调用
    // 出现在它爹的悬浮时间线里了(与「子调用不进主消息列表、只在子智能体那里看」同一条
    // 口径)。把它也提成一张顶层卡,人看到的就是「我派了三个,面板上冒出九个」。
    if (item.parentToolCallId) continue;
    // 启动就没成的,没有智能体在跑。
    if (item.status === 'error') continue;
    if (item.agentStatus !== undefined) {
      if (item.agentStatus !== 'running') continue;
    } else if (item.background === true) {
      if (notified.has(item.toolCallId)) continue;
      if (replayed.has(item.toolCallId)) continue;
    } else if (item.status !== 'running') {
      continue;
    }
    const calls = [...(callsByParent.get(item.toolCallId)?.values() ?? [])];
    const steps = calls.filter((call) => call.status === 'done').length;
    const startedAt = item.agentStartedAt ?? item.startedAt;
    const elapsedMs = startedAt !== undefined ? Math.max(0, now - startedAt) : 0;
    // 同一次派发会来好几条事件 ⇒ 按 toolCallId 去重,后到的覆盖先到的(名字是后面才补齐的)。
    byCallId.set(item.toolCallId, {
      id: item.id,
      launchToolCallId: item.toolCallId,
      name: item.inputSummary || item.name || item.title || fallbackName,
      ...(item.model ? { model: item.model } : {}),
      completedSteps: steps,
      // 按时序 —— 面板那条时间线照这个顺序画。
      calls: [...calls].sort((a, b) => a.seq - b.seq),
      elapsedMs,
      canCancel: item.canCancel === true,
    });
  }
  return [...byCallId.values()];
}

/**
 * 哪些派发已经来过「跑完了」的通知。
 *
 * ⚠️ 只认**终局**那两种。`pending` / `in_progress` 也走同一条通知通道,把它们一起算进来
 * 等于刚派出去就把卡撤了。
 */
function collectNotified(items: readonly TranscriptItem[], out: Set<string>): void {
  for (const item of items as readonly ToolNode[]) {
    if (item.kind === 'subagent-done-tool-call') {
      // 只认**终局**。通知通道里 pending / in_progress 也会来,把它们一起算进去
      // 等于刚派出去就把卡撤了。
      if (item.status === 'done' || item.status === 'error') out.add(item.launchToolCallId);
    }
    const children = 'children' in item && item.children ? item.children : undefined;
    if (children) collectNotified(children as readonly TranscriptItem[], out);
  }
}
