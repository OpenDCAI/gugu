import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { useState, type FocusEvent } from 'react';
import { useToolbarOutOfRoom } from '@gugu/session-ui/react/components';
import { ChevronDown } from '@/lib/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { isSessionView, type SessionView } from '@shared/core/sessions/sessions';

import type { SessionViewLockReason, SessionViewLockState } from './session-view-lock';
export type { SessionViewLockReason, SessionViewLockState } from './session-view-lock';

/**
 * 展示切换控件:「终端 | 通用」(owner 2026-10-29 恢复手动切换,英文 Terminal | Work)。
 *
 * **它选的是哪一种展示,不是哪根管子** —— owner 原话:「本质上这就是两种不同的展示:一个是编程
 * 视角的展示,一个是通用视角的展示」。所以这一层从类型到变量到 test-id 一律说 `SessionView`
 * (`'code' | 'general'`);`pty` / `acp` 是运行时起哪种进程的事实,只在跨到运行时/落库那一刻
 * 翻译一次(`sessionRuntimeOfView`)。❌ 别把传输词回流进产品层——那正是「Chat UI 开关」
 * 留下的误会。
 *
 * 可见文案(编程 / 通用 / Code / Work)只活在 i18n `taskConfig.sessionView*`:它 2026-09-03
 * 一夜改过三次,而标识符一次没动——这正是两层分开的用处。
 *
 * 为什么是两段并排各有名字,不是一个开关:开关只给「开」那一头起名,「关」永远是「不是那个」——
 * 用户看到 "Chat UI" 和一个关着的开关,得自己推另一头是什么。两段各写各的名字,不用推。
 *
 * 语义是**单选组**(role=radiogroup / radio),不是 tabs:它选的是「这条会话以什么展示开」,
 * 没有随之切换的内容面板。方向键在两段之间移动并切换(Base UI RadioGroup 自带),
 * 被锁的那一头 `disabled`,方向键会跳过它;锁的原因挂在整个控件的 title 上,悬停可读。
 *
 * 视觉**必须与同排邻居同构**:那一排(`+` / 权限 / Agent / 模型)全是无边框、无托底的纯文字
 * 触发器,只在悬浮或展开时铺一层 `--composer-surface-selected`。所以本控件也只有那一层:
 * 容器透明(❌ 不要托底轨道),选中段就是那层填充 + 正文色,未选中是 muted 文字。
 * ❌ 别再加描边 / 阴影 / 凸起药丸 —— owner 2026-09-03 实测原话「这个控件不好看,和其他格格不入,
 * 不协调」,病根就是它比邻居多长了两层(托底 + 带 ring/shadow 的凸起块),在一排纯文字里凭空
 * 多出一个视觉层级。几何对齐邻居:高 1.75rem、圆角 md、text-xs(见 chat-composer.css.ts 的
 * `agentTrigger`)。⚠️ 间距只用整步(`gap-1` / `px-2`):`check-ui-visual-spec` 的半步棘轮禁止新增
 * 半步间距工具类。⚠️ 那道闸扫的是**源文本**,连注释一起数 —— 所以这行不能把被禁的类名写出来。
 * 静止 / 悬浮 / 按下 / 选中 / 键盘焦点 / 禁用六态齐全 —— product spec
 * 把缺态定为 bug;选中靠填充(不是只靠颜色),悬浮靠文字提亮,两者不撞。
 *
 * ## @@@session-view-collapsed — 底排最紧那一档换成下拉
 *
 * owner 2026-09-05:「把那个编程和通用的切换弄成箭头倒是可以吧,省点空间」。所以进到 composer
 * 底排渐进披露的**最后一档**(见 `use-toolbar-disclosure.ts`)时,两段并排换成「当前那一段 +
 * 一个下拉箭头」,另一段进下拉里。宽度从两段变一段,是这一排最后能让出的一块。
 *
 * ⚠️ **换的是渲染形态,不是用 CSS 藏掉另一段** —— 藏掉那一段就点不到它,而仓库对假控件是零容忍
 * (控件要么真生效要么不渲染)。两种形态里两个选项都真能选。
 *
 * ⚠️ owner 2026-08-21「选不了的那一头要留在原地并说明原因」在收起形态里照旧成立:两个选项都在
 * 下拉里,不可选的那一个是 `disabled` 而不是消失,原因仍挂在触发器的 title 上、并补挂在那一项上。
 *
 * 收起形态的几何与状态**必须和展开形态、以及同排邻居一致**:高 1.75rem、圆角 md、text-xs、
 * 悬浮/展开铺同一层填充。箭头 12px,与这一排另外三枚同尺寸(见 @@@combobox-chevron-size)。
 *
 * 单独用在工具栏之外时读到「还有地方」,永远是完整的两段形态。
 */
export function SessionViewControl({
  value,
  onChange,
  lock,
  agentName,
  disabled = false,
}: {
  value: SessionView;
  onChange: (next: SessionView) => void;
  lock?: SessionViewLockState | null;
  /** 锁的原因里点名的是哪一家。 */
  agentName: string;
  /** 整个控件不可用(还没选 agent):两段都灰。 */
  disabled?: boolean;
}) {
  const { translate } = useSessionMessages();
  const collapsed = useToolbarOutOfRoom();
  const segments: ReadonlyArray<{ view: SessionView; label: string }> = [
    { view: 'code', label: translate('taskConfig.sessionViewCode') },
    { view: 'general', label: translate('taskConfig.sessionViewGeneral') },
  ];
  const lockReason = lock ? lockReasonText(lock.reason, agentName, translate) : undefined;
  const isSegmentLocked = (view: SessionView) => (lock ? lock.view !== view : false);

  // 静息只留当前那一段,另一段原地收成零宽(owner 2026-09-07「默认是折叠的」)。
  //
  // **折叠的是宽度,不是那个名字** —— 展开后两段仍各写各的名字,2026-09-03 定的
  // 「❌ 不做成只给一头起名的开关」那条没有被推翻:开关的问题是另一头永远没有名字,
  // 这里另一头只是此刻没占地方,鼠标一碰就在原地写出来。
  //
  // ⚠️ 这一档与下面那个 `collapsed`(渐进披露最后一档换成下拉)是**两回事**,别合并:
  // 这里是"地方够、但默认不铺开";那里是"地方真不够、只能换形态"。
  //
  // ❌ 不用 CSS 的 group-hover 变体做这件事:Tailwind v4 在这棵树里遇到解析不出来的东西是
  // **静默不出规则**(本仓翻过车,见 session-composer-styles.ts 抬头),而"展不开"这种失败在
  // 截图上看着就像设计如此。用 state 至少是确定的。
  const [expanded, setExpanded] = useState(false);
  // 键盘:方向键会把焦点移到收起来的那一段上,不展开的话焦点就落在一个零宽元素里。
  // onFocus/onBlur 在 React 里冒泡,relatedTarget 还在组内就不算离开。
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setExpanded(false);
  };

  if (collapsed) {
    const selectedLabel = segments.find((segment) => segment.view === value)?.label ?? '';
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={translate('taskConfig.sessionView')}
          data-testid="session-view-control"
          data-locked={lock ? lock.view : undefined}
          data-collapsed="true"
          title={lockReason}
          disabled={disabled}
          className={cn(
            'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2',
            'border border-transparent text-xs leading-none text-foreground select-none',
            '!transition-[background-color,color] !duration-[var(--dur-fast)] ease-out motion-reduce:!transition-none',
            'outline-none hover:bg-row-hover data-popup-open:bg-row-selected',
            'focus-visible:border-border-primary',
            'data-disabled:cursor-not-allowed data-disabled:opacity-50'
          )}
        >
          {selectedLabel}
          <ChevronDown className="size-3 shrink-0 text-foreground-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto min-w-32">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (isSessionView(next)) onChange(next);
            }}
          >
            {segments.map((segment) => (
              <DropdownMenuRadioItem
                key={segment.view}
                value={segment.view}
                disabled={isSegmentLocked(segment.view)}
                data-testid={`session-view-${segment.view}`}
                // 锁的原因既挂在触发器上,也挂在被锁的那一项上 —— 下拉打开后触发器的 title
                // 读不到了,而「为什么这一头不能选」正是要在看见它变灰的那一刻能问出来的。
                title={isSegmentLocked(segment.view) ? lockReason : undefined}
              >
                {segment.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <RadioGroup
      aria-label={translate('taskConfig.sessionView')}
      data-testid="session-view-control"
      data-locked={lock ? lock.view : undefined}
      title={lockReason}
      value={value}
      onValueChange={(next) => {
        if (isSessionView(next)) onChange(next);
      }}
      disabled={disabled}
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={handleBlur}
      data-expanded={expanded ? '' : undefined}
      className={cn(
        // h-8 而不是 h-7:同排邻居(附件键 / 三颗触发器 / 发送键)全是 2rem。
        'inline-flex h-8 shrink-0 items-center gap-1',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50'
      )}
    >
      {segments.map((segment) => {
        // 收起的永远是"不是当前值"的那一段 —— 当前值必须一直在,它是这颗控件的读数。
        const collapsed = !expanded && segment.view !== value;
        return (
          <Radio.Root
            key={segment.view}
            value={segment.view}
            disabled={isSegmentLocked(segment.view)}
            data-testid={`session-view-${segment.view}`}
            // 触屏没有悬浮:点当前那一段 = 展开(它本来就是选中的,再选一次没有别的含义)。
            onClick={() => {
              if (segment.view === value) setExpanded((v) => !v);
            }}
            className={cn(
              // 圆角、字号、内距对齐同排:rounded-md(8px)/ 13px / px-3。
              // @@@bottom-row-shape (Refs #6104,2026-09-22) —— 原来是 `rounded-full`,理由是
              // 「对齐同排」;而同排的 agentTrigger(packages/session-ui/.../chat-composer.css.ts)
              // 这一轮已经退回 `radiusMd`(8px):design.md 的 shape 表把 --radius-capsule(9999)
              // 只发给 switch / 头像 / 状态点,并明写「Never pills」。两枚必须**一起**改 ——
              // 只改一枚就是这一排里一个药丸一个方角,比两枚都错还显眼(这也是 C 区当时搁置它的原因)。
              // ⚠️ 字号**直接引 `--em-text-sm`,不走 Tailwind 的 text-sm**。真机量过两次都不对:
              //    写 `text-xs` 得到 11px、写 `text-sm` 得到 **14px** —— 这个控件渲染在会话页
              //    子树,那棵树的 `--text-*` 与主 app 不是一套(主 app text-sm=13)。而它的邻居
              //    (agentTrigger 等)走的是 `tokenVars.textSm` = `--em-text-sm` = 13px。
              //    两边同源才对得齐;❌ 别再用 Tailwind 的字号档去猜这棵树里它等于几。
              'inline-flex h-full cursor-pointer items-center justify-center overflow-hidden',
              'rounded-md px-3 text-[length:var(--em-text-sm)] leading-none whitespace-nowrap select-none',
              'border border-transparent text-foreground-muted outline-none',
              '!transition-[background-color,color,max-width,padding,opacity] !duration-[var(--dur-fast)] ease-out motion-reduce:!transition-none',
              'data-unchecked:hover:text-foreground',
              // ❌ 选中段不再用正文色:折叠之后可见的只有选中那一段,它就是这颗控件的**当前值**,
              //    与邻居显示当前值(Claude / Haiku / 完全访问)是同一个角色,该同一档色。
              //    真机实测:给它正文黑之后,整排压灰的版面里它成了唯一的黑字,反而最跳。
              //    选中态仍**靠填充**表达(product spec 要求不能只靠颜色)。
              // @@@state-ladder-mix owner 2026-09-09 圈它「不统一」。真机取色后看清楚了:
              // 不统一的是**色相**,不是深浅 —— 明色下这一段的选中底 rgb(243,244,246) 与同排邻居
              // (Agent/模型触发器)当前值的 rgb(241,246,254) 亮度几乎一样,但一个中性灰、一个偏蓝,
              // 并排看就是"两套东西"。所以改取邻居那一档,同排同源。
              // 这**不违反** product spec 的「行选中与 tab/分段选中不得混用」:
              // 那条要的是「行=近乎无感的浅 tint,tab=实底色块」,而 --em-surface-selected 是
              // color-mix 出来的**不透明实底**,行选中用的 --selected 是**半透明 tint**,
              // 两者依旧是两种视觉;只是"选中"这件事在全产品有了同一个色相语言。
              'data-checked:bg-[var(--em-surface-selected)]',
              // 开着的那一段也要有悬浮/按下：叠一层，不动它的容器族底色。
              'data-checked:hover:state-hover-layer data-checked:active:state-press-layer',
              'hover:text-foreground',
              'focus-visible:border-border-primary',
              'data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:text-foreground-muted',
              // 两个端点都写死,过渡才有得插值(max-w-none 到 0 是不动画的)。
              collapsed ? 'max-w-0 px-0 opacity-0' : 'max-w-24 opacity-100'
            )}
          >
            {segment.label}
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}

function lockReasonText(
  reason: SessionViewLockReason,
  agentName: string,
  translate: ReturnType<typeof useSessionMessages>['translate']
): string {
  switch (reason) {
    case 'general-only':
      return translate('taskConfig.sessionViewGeneralOnly', { name: agentName });
    case 'general-required-here':
      return translate('taskConfig.sessionViewGeneralRequiredHere', { name: agentName });
    case 'code-only':
      return translate('taskConfig.sessionViewCodeOnly', { name: agentName });
    case 'remote-needs-ssh':
      return translate('taskConfig.sessionViewRemoteNeedsSsh');
  }
}
