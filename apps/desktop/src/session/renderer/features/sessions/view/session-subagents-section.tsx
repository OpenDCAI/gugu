import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Check, Square, X } from '@/lib/icons'
import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { collectSubagentRoster, formatElapsed, type SubagentRosterEntry } from '@gugu/session-chat-ui';
import { Popover, PopoverContent } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isSubagentDismissed } from './subagent-dismissals';

/**
 * 「输出/来源」面板里的子智能体花名册 —— 上游 `elements-subagent-list` 落在这儿
 * (owner 2026-09-05 定的位置:「这个 subagent-list 其实也是放这里的,而消息列表其实
 * 还是 tool call」)。
 *
 * ⚠️ **这里是照抄上游的画法,不是照它的解剖自己重画。** owner 已经说过好几遍
 * 「直接照抄 assistant 的 UI 设计」,我前几版一直在「取结构不取像素」,于是每次都自己
 * 重画一遍尺寸/圆角/字号/配色 —— 结果显得不协调。
 *
 * 逐格对着上游源码
 * (`packages/ui/src/components/react/assistant-ui/elements/subagent-list.tsx`):
 *   · 卡:`paper` + `rounded-lg` + 内边距,卡间 `gap-2`
 *     (`paper = bg-background border border-border/60 dark:bg-popover`)
 *   · 记号:done → `CheckIcon size-3.5 text-emerald-500` 带 `fade-in zoom-in-90`;
 *     跑着 → 共用的 `LoadingIndicator`
 *   · 名字:`flex-1 truncate` + 正文字号
 *   · 模型:`mono text-foreground/35`(`mono = font-mono text-[length:var(--font-caption)] tracking-tight`)
 *   · 进度条:轨 `bg-foreground/[0.06] h-[3px] rounded-full`,
 *     填充 `bg-emerald-500/70`(done)/ `bg-foreground/60`,`transition-[width] duration-700`
 *
 * ⚠️ 这些 shadcn 风格的 color key 在**这一层**是真能编出 CSS 的:会话页 renderer 的
 * `@theme` 里 `--color-background` / `--color-border` / `--color-popover` /
 * `--color-foreground` 都在,`emerald` 是 Tailwind 自带调色板(本目录已有别处在用)。
 * ❌ 但别把这条经验搬去会话页 index.css 的 em 命名空间 —— 那边的 @theme 是另一套命名,
 * Tailwind v4 对不存在的 key **静默丢掉整条 utility**(#2319 翻过车)。
 *
 * 三处**刻意**的偏离,都是容器差异不是审美改动:
 *   1. 根上不套 `max-w-xs`:上游是独立小卡片,这里要填满面板的宽度;
 *   2. 不要 `min-h-[14.5rem]`:那是上游为"总结卡淡入时别跳版"留的位,这里没有总结卡,
 *      留着会在只有一两个 worker 时凭空空出一大块;
 *   3. 图标用仓里的 Solar `Check` 与共用加载指示,不引 lucide —— 同一屏两套图标是本仓
 *      明令避免的(见 `@/lib/icons` 顶部)。字形同义,画法归家。
 *   4. 字号与内边距落回本仓的尺子:上游名字用的是 13.5 像素、卡内边距 14/10,这里是
 *      `text-sm` 与 `px-3 py-2`。**不是我又在自作主张改审美** —— 仓里两道闸各有实因:
 *      字阶只收 11/13/15/17/20(半个像素会被屏幕四舍五入,同一界面换缩放就飘),
 *      半步内边距是只减不增的棘轮(#3334 拍的)。差的是 0.5px 与 2px,肉眼无别;
 *      真正让它先前难看的是没有卡面、6px 直角、挤成一行、以及一条通栏细线冒充分隔线,
 *      那几样这一版全按上游改了。
 *
 * 2026-09-22 按 design.md 统一,原裁决:上面那条「卡 = `paper`(border + bg-popover)+
 * rounded-lg」改成密度面板 —— design.md 的分组法是「用密度变化代替画框」
 * (a field panel with no border groups machine content; a card around every row
 * is the thing to reject),逐行画框正是它点名要去掉的形状。改的只是「每行加不加框」
 * 这一步,不是退回 owner 那次反馈之前的样子:分组感现在靠列表外层的
 * `bg-background-1` 面板 + 行距 + 逐行 `hover:bg-row-hover` 维持,不是靠线或框。
 */

/**
 * 会话页的 store 在 `AcpChatResourceManager` 里。
 * 调用方必须在 mobx `observer` 里 —— `messageCount` 是显式读的那一个依赖。
 */
export function collectSubagents(
  sessionId: string | undefined,
  fallbackName: string,
  now?: number
): SubagentRosterEntry[] {
  if (!sessionId) return [];
  const store = findAcpChatStore(sessionId);
  if (!store) return [];
  void store.messageCount;
  const transcript = store.chatState.transcript.state;
  return collectSubagentRoster(
    transcript.committedTurns,
    transcript.activeTurnSnapshot,
    fallbackName,
    now
    // 「我不看它了」是显示层的事,所以过滤在这儿、不在 `collectSubagentRoster` 里:
    // 那个函数是纯的,它只该回答「谁还在跑」,不该知道有人按过 ×。
  ).filter((entry) => !isSubagentDismissed(sessionId, entry.id));
}

/**
 * 每秒走一步的心跳 —— 只为让时间那一路的进度**看得见地**往前爬。
 *
 * ⚠️ 只在这一节挂着时跑(面板是弹出层,关掉就卸载),❌ 不常驻。
 * 进度值本身不靠这个心跳算(它算在 `startedAt` 上),心跳只负责触发重绘 ——
 * 所以就算这个定时器被节流或漏掉几拍,条子也不会错位,只是慢一拍。
 */
export function useProgressTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 上游 `surfaces.tsx` 的共享类,原样照抄;`paper`(逐行画框)按 design.md 已去掉,见上方 2026-09-22 注。 */
const mono = 'font-mono text-[length:var(--font-caption)] tracking-tight';

export function SessionSubagentsSection({
  agents,
  onDismiss,
  onStop,
}: {
  agents: readonly SubagentRosterEntry[];
  /** 按了悬浮面板里那个 × —— 只把这张卡从名册收起,❌ 不动它的状态,见 subagent-dismissals。 */
  onDismiss: (entryId: string) => void;
  /** 按了悬浮面板里的「停止」—— 真去停它(#5117),传派发它那次调用的 tool_use id。 */
  onStop: (launchToolCallId: string) => void;
}) {
  const { translate } = useSessionMessages();

  // 一个在跑的都没有 ⇒ 整节不画(连标题带分隔线一起)。
  // owner 2026-09-05:「这里的清不掉啊,不能一直占位啊」—— 子智能体随这一轮死,
  // 跑完它就不该在面板上留一行空位,更不该攒成一摞历史。
  if (agents.length === 0) return null;

  return (
    <>
      <div className="px-2 text-xs font-medium text-foreground-muted">
        {translate('task.subagents')}
      </div>
      <div
        data-slot="subagent-list"
        className="flex max-h-64 w-full flex-col gap-1 overflow-y-auto rounded-lg bg-background-1 p-1"
      >
        {agents.map((agent) => (
          <SubagentCard
            key={agent.id}
            agent={agent}
            onDismiss={onDismiss}
            onStop={onStop}
          />
        ))}
      </div>
    </>
  );
}

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 160;

/**
 * 一个子智能体一张卡;**悬浮在它身上**弹出它自己的进度面板
 * (owner 2026-09-06:「悬浮上去,出来进度面板啊…用 tool-timeline 展示他的进度,
 * 可以滚动轴如果太长的话」)。
 *
 * ⚠️ 卡面本身只说三样:它是谁、跑在哪个模型上、走到哪儿了。它**具体在调什么**留给
 * 悬浮面板 —— 先前直接把最近那条查询串印在卡上,一行截断的长搜索词,又丑又读不全。
 */
function SubagentCard({
  agent,
  onDismiss,
  onStop,
}: {
  agent: SubagentRosterEntry;
  onDismiss: (entryId: string) => void;
  onStop: (launchToolCallId: string) => void;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const schedule = useCallback((next: boolean, delay: number) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  }, []);
  // 挂了就把待办的定时器撤掉,❌ 别让它在卡已经消失之后再去 setState。
  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    []
  );

  // 只显示子任务自己报告的模型；没有报告时留空。
  const shownModel = agent.model ?? null;

  return (
    <>
      <div
        ref={setAnchor}
        data-slot="subagent-card"
        className="hover:bg-row-hover flex items-center gap-2 rounded-sm px-2 py-1"
        onMouseEnter={() => schedule(true, OPEN_DELAY_MS)}
        onMouseLeave={() => schedule(false, CLOSE_DELAY_MS)}
      >
        {/* 名册只收「还没回话、且启动没失败」的(见 collectSubagentRoster),
            所以这里没有「已完成」也没有「失败」那两支 —— ❌ 别为了照抄上游把它们留着,
            留着就是永远画不出来的死码。 */}
        <LoadingIndicator size="inline" className="shrink-0 text-foreground/35" />
        {/* 悬停这张卡的回答是下面那个进度面板(全名也在那里);❌ 再挂原生 title,两个浮层会叠在一起。 */}
        <span className="flex-1 truncate text-sm">{agent.name}</span>
        {/* 步数与时长。
            ⚠️ 进度条撤了 —— owner 2026-09-06:「进度条只是好看,步数才能表达出来进度」。
            那条确实只是好看:它是按步数与时长凑出来的**模糊估算**(见 subagent-progress),
            永远够不到 100、也不对应任何真实百分比。⇒ 把真读数直接写出来,顺带把卡压到一行。
            shrink-0:名字长了压名字,❌ 不压这两格(压没了就等于没显示)。 */}
        <span className={cn(mono, 'shrink-0 text-foreground/45')}>
          {translate('task.subagentSteps', { count: agent.completedSteps })}
        </span>
        <span className={cn(mono, 'shrink-0 text-foreground/45')}>
          {formatElapsed(agent.elapsedMs)}
        </span>
      </div>
      <Popover open={open && anchor !== null} onOpenChange={setOpen}>
        <PopoverContent
          anchor={anchor}
          side="left"
          align="start"
          sideOffset={8}
          initialFocus={false}
          finalFocus={false}
          className="w-80 gap-2 p-3"
          data-slot="subagent-hover-panel"
          onMouseEnter={() => schedule(true, 0)}
          onMouseLeave={() => schedule(false, CLOSE_DELAY_MS)}
        >
          <SubagentTimeline agent={agent} model={shownModel} onDismiss={onDismiss} onStop={onStop} />
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * 这个子智能体自己跑过的每一步 —— 上游 `elements-tool-timeline` 的那条竖线。
 *
 * ⚠️ 这些调用**不**在主消息列表里出现(owner 2026-09-05 定的),所以这儿是读者唯一
 * 能看到它们的地方 —— ❌ 不许因为「太长」就截掉几条:太长给滚动轴
 * (owner 2026-09-06:「可以滚动轴如果太长的话」)。
 */
function SubagentTimeline({
  agent,
  model,
  onDismiss,
  onStop,
}: {
  agent: SubagentRosterEntry;
  /** 它实际跑在哪个模型上。卡面窄了放不下,挪到这儿 —— ❌ 不是删掉。 */
  model: string | null;
  onDismiss: (entryId: string) => void;
  onStop: (launchToolCallId: string) => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <>
      {/* 这个面板本身就是悬停浮层:里面的字折行写全,按钮的说明走产品 Tooltip,❌ 原生 title 叠在面板上。
          名字独占一行:它是派它时写的任务描述,长短不定。与模型、时长、两颗按钮挤在同一行时,那四样都不压缩,
          名字被挤成一窄列逐词折行(owner 10-19 截图)。 */}
      <span className="break-words text-sm">{agent.name}</span>
      <div className="flex items-center gap-2">
        {model && <span className={cn(mono, 'min-w-0 truncate text-foreground/35')}>{model}</span>}
        <span className={cn(mono, 'shrink-0 text-foreground/45')}>
          {formatElapsed(agent.elapsedMs)}
        </span>
        {/* 停止它(#5117,owner:「让我可以在子智能体那里点击取消子智能体运行」)。与右边那个 ×
            是两件事:这颗真把它停掉(适配器 `_session/async_task/stop` → SDK `stop_task`),
            × 只是不再看它。停成了供应商会回一条 stopped 通知,转录那一行落成「子智能体已停止」、
            这张卡随之撤下 —— 这里不预演结果,按下去卡还在就是还没停。
            长在浮层里的理由与 × 相同(见下)。 */}
        {agent.canCancel === true && <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-slot="subagent-stop"
                aria-label={translate('task.subagentStop')}
                onClick={() => onStop(agent.launchToolCallId)}
                className="ml-auto shrink-0 rounded-sm p-1 text-foreground/35 transition-colors hover:text-destructive"
              >
                {/* 实心方块 = 「停止」的通行字形(播放器/composer 的停止键同款)。Solar 的 Square 路径自带
                    fill="none",空心的看着像一个没勾的复选框(2026-09-06 真机截图),所以把路径填实。 */}
                <Square className="size-3 [&_path]:fill-current" />
              </button>
            }
          />
          <TooltipContent>{translate('task.subagentStop')}</TooltipContent>
        </Tooltip>}
        {/* 手动收起(owner 2026-09-06:「悬浮出个 x 号,手动关这样子」)。
            ⚠️ 它**不停**那个子智能体,只是不再占着面板 —— 名字里就把这句说清楚,
            ❌ 别叫「结束」「取消」,真停它的是左边那颗。

            ⚠️ × 必须长在**这个浮层里面**,❌ 不能长在卡上。悬浮先把这个浮层打开,而浮层
            对「外面」的按下会当成 outside-press 吃掉 —— 卡上那颗 × 正好在外面,于是第一次
            点必然没反应、第二次才生效。2026-09-06 在实例上按一个自由度量过:同一颗按钮、
            同一种点击,浮层开着→吞,浮层没开→一次就生效。长在浮层里就不存在这个问题。 */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-slot="subagent-dismiss"
                aria-label={translate('task.subagentDismiss')}
                onClick={() => onDismiss(agent.id)}
                className="shrink-0 rounded-sm p-1 text-foreground/35 transition-colors hover:text-foreground/70"
              >
                <X className="size-3" />
              </button>
            }
          />
          <TooltipContent>{translate('task.subagentDismiss')}</TooltipContent>
        </Tooltip>
      </div>
      {agent.calls.length === 0 ? (
        // ❌ 不编一句「正在工作」:那句话在它卡住时和在它干活时长得一模一样。
        // 它确实还一次工具都没调 —— 就这么说。
        <span className={cn(mono, 'text-foreground/35')}>{translate('task.subagentNoSteps')}</span>
      ) : (
        <div
          data-slot="subagent-timeline"
          className="flex max-h-56 flex-col gap-1 overflow-y-auto"
        >
          {agent.calls.map((call) => (
            // 标题折行写全。字号挂在行上,记号那格的 1lh 才等于正文一行 ⇒ 折行时记号对齐第一行。
            <div key={call.toolCallId} className="flex items-start gap-2 text-chrome-body">
              <span className="flex h-[1lh] shrink-0 items-center">
                {call.status === 'done' ? (
                  // 原生 emerald-500 → 家族色(design.md one-knob:颜色只能从 token 家族出)。
                  <Check className="size-3 text-foreground-success" />
                ) : call.status === 'error' ? (
                  <span className="size-1.5 rounded-full bg-destructive" />
                ) : (
                  <LoadingIndicator size="inline" className="text-foreground/35" />
                )}
              </span>
              {/* @@@text-chrome-body (Refs #6104) — 13 这一档在会话页原来只有 --text-code
                  一个名字,而这行是**界面自己的正文**不是代码 ⇒ 这里从前只好写 13px 字面量。
                  现在它有自己的角色名(index.css 的 @theme:--text-chrome-body)。 */}
              <span className="min-w-0 break-words text-foreground/70">{call.title}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
