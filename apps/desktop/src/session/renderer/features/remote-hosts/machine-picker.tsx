// #6264 选机器的那一个组件。凡是「选一台机器」的地方都用它:资源库、已安排、设置(通用 / 仓库 / 存储)、
// 导入会话、新建框。❌ 各处再写一个自己的样子 —— owner:「如果设备是关键,你是否应该放到更显眼的位置,
// 并且那个组件统一且好看」。
//
// 长相照抄 app 里现成的选择器触发器(新建框托盘里的项目选择器「未选择项目 ⌄」、项目顶栏的名字 ⌄):
// ghost —— 没有边框、静息没有底色,只有 app 的标准悬停 / 按下 / 开着三档(row-hover / press / selected)。
//   · title:页标题右边,text-sm、muted、悬停变前景色(同项目顶栏那个名字下拉);
//   · compact:新建框托盘里,直接用托盘触发器那一条样式(sessionComposerTrayTriggerClassName)。
// 触发器里只放:机器种类图标 · (别的机器才有的)在线点 · 名字 · (离线时)淡色「离线」 · 箭头。
// 系统与连法只在菜单行里:行的写法同项目选择器的行(图标 + 名字,右边一段淡色的 small)。
import type { ReactNode } from 'react';
import { Check, ChevronDown, Cloud, Monitor, Plus, Server } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import {
  sessionComposerTrayChipClassName,
  sessionComposerTrayTriggerClassName,
} from '@renderer/features/sessions/session-composer-styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { machineAcceptsWork, machineMeta, orderMachines, type MachineChoice } from './machine-choice';
import { remoteHostsStore } from './remote-hosts-store';

/**
 * 在线点。连着 = live 蓝(design.md 唯一的 accent),❌ 成功绿;连着但不回话留琥珀;离线退成最淡的墨。
 * 正圆 ⇒ --radius-circle,❌ 借胶囊的 rounded-full 碰巧同形。
 */
function MachineDot({ machine }: { machine: MachineChoice }) {
  const online = machine.isLocal || machine.isOnline;
  // #7199 云电脑没醒着:休眠中 = live 空心圈,正在唤醒 = live 一呼一吸;❌ 退成离线那一档淡墨。
  const cloud = machine.cloudComputer;
  return (
    <span
      aria-hidden="true"
      data-slot="machine-dot"
      data-state={cloud ?? (!online ? 'offline' : machine.notResponding ? 'not-responding' : 'live')}
      className={cn(
        'size-1.5 shrink-0 rounded-[var(--radius-circle,50%)]',
        cloud === 'asleep' || cloud === 'wake-failed'
          ? 'border border-live bg-transparent'
          : cloud === 'waking'
            ? 'animate-pulse bg-live motion-reduce:animate-none'
            : !online
              ? 'bg-foreground-passive'
              : machine.notResponding
                ? 'bg-foreground-warning'
                : 'bg-live'
      )}
    />
  );
}

/** 机器种类图标:它说的是「这是哪一类机器」,不是装饰。 */
function MachineKindIcon({ machine, className }: { machine: MachineChoice; className?: string }) {
  const Icon = machine.kind === 'cloudComputer' ? Cloud : machine.kind === 'server' ? Server : Monitor;
  return <Icon aria-hidden="true" data-kind={machine.kind ?? 'computer'} className={cn('shrink-0', className)} />;
}

/**
 * 侧栏那一格与它菜单里的机器方块(shadcn TeamSwitcher 的 logo 方块):触发器与菜单行同一种细边空心方块(owner 嫌墨色实心「太黑」),
 * 触发器上的小一号。别的机器在方块右下角挂在线点,外圈一道底色把点和方块分开(头像在线点的惯例)。
 */
export function MachineTile({ machine, solid }: { machine: MachineChoice | null; solid: boolean }) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        solid ? 'size-6 rounded-md border border-border text-foreground' : 'size-7 rounded-md border border-border'
      )}
    >
      {machine ? (
        <MachineKindIcon machine={machine} className="size-3.5" />
      ) : (
        <Monitor aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      {machine && !machine.isLocal ? (
        <span
          className={cn(
            'absolute right-[-3px] bottom-[-3px] flex rounded-[var(--radius-circle,50%)] p-[2px]',
            solid ? 'bg-background' : 'bg-background-quaternary'
          )}
        >
          <MachineDot machine={machine} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * 一台机器的一行:种类图标 · (别的机器才有的)在线点 · 名字 · 右边淡色的状态(machineMeta)。选择器菜单与安装卡的设备表同一副,
 * ❌ 各处再拼一个;`trailing` 是行尾的勾(安装卡多选)。外层的行容器由用处给(菜单项 / label)。
 */
export function MachineRow({ machine, meta, trailing }: { machine: MachineChoice; meta: string | null; trailing?: ReactNode }) {
  return (
    <>
      <MachineKindIcon machine={machine} className="size-3.5" />
      {!machine.isLocal ? <MachineDot machine={machine} /> : null}
      <span title={machine.label} className="min-w-0 truncate">
        {machine.label}
      </span>
      {meta ? <small className="ml-auto shrink-0 pl-3 text-foreground-muted">{meta}</small> : null}
      {trailing ? <span className={cn('flex shrink-0', meta ? 'pl-2' : 'ml-auto pl-3')}>{trailing}</span> : null}
    </>
  );
}

/** 名字在上、系统与连法(或「离线 · X 前」)在下,两行。 */
export function MachineLines({ label, meta, muted }: { label: string; meta: string | null; muted?: boolean }) {
  return (
    <span className="grid min-w-0 flex-1 text-left leading-tight">
      <span title={label} className={cn('truncate text-sm font-medium', muted ? 'text-foreground-passive' : 'text-foreground')}>
        {label}
      </span>
      {meta ? (
        <span className="truncate text-xs text-foreground-muted" data-slot="machine-meta">
          {meta}
        </span>
      ) : null}
    </span>
  );
}

// 页标题旁那一格:就是托盘里项目选择器那条触发器样式(ghost + 叠色三件套),只把字号放到页面的 text-sm、
// 高度对齐标题的 28px 行高、字色取页面上的 muted。❌ 另拍一套边框 / 底色。
const titleTriggerClassName = `${sessionComposerTrayTriggerClassName} h-7 text-sm text-foreground-muted data-popup-open:text-foreground`;

export function MachinePicker({
  machines,
  selectedId,
  onSelect,
  onAddMachine,
  size = 'title',
  side,
  offlineSelectable = false,
  variant = 'inline',
  testId = 'machine-picker',
  lockedHint,
  wakeOnPick = 'always',
}: {
  machines: readonly MachineChoice[];
  selectedId: string | null;
  onSelect: (machineId: string) => void;
  /**
   * #7199 选中一台没醒着的云电脑时叫不叫醒它:always = 选它就是要用它(资源库、导入、历史这类页面);
   * retry = 新建框里选它只是定目标、开始输入才叫(useWakeCloudOnInput),只有叫醒没成之后再点它 = 再叫一次。
   */
  wakeOnPick?: 'always' | 'retry';
  /** 「添加一台机器」→ 设置 → 设备。没给 = 这个宿主没有这个入口,不摆。 */
  onAddMachine?: () => void;
  /** title = 页标题旁;compact = 新建框托盘里。 */
  size?: 'title' | 'compact';
  /** 菜单往哪边开。缺省:页标题旁往下开,托盘(贴着页底)往上开。 */
  side?: 'top' | 'bottom';
  /**
   * 离线的机器也能选(淡着、写「离线 · X 前」)。新建框里选了也建不了,所以不给选;
   * 资源库这类页面选它是为了看它上次的样子(只读),所以给选。
   */
  offlineSelectable?: boolean;
  /**
   * sidebar = 资源库左栏列头下那一格:照 shadcn 侧栏的 TeamSwitcher(Vercel / Linear / Supabase 顶上的范围切换同形)——
   * 24px 细边方块里是机器种类图标(别的机器在角上挂在线点),右边一行名字,最右箭头(同 Linear 的工作区切换,单行)。
   * 整格就是一行导航项:同 px-3 左缘、同悬停 / 按下底色,占满列宽;列宽固定 w-36,❌ 被它撑宽(owner:「这么大空白」)。
   */
  variant?: 'inline' | 'sidebar';
  testId?: string;
  /**
   * 非空 = 这里的机器由上层目标决定(项目页:所选文件夹在哪台机器上,新会话就在哪台上跑)。只显示所选那台、不开菜单,
   * 悬停说这一句。长相同托盘里的只读项(sessionComposerTrayChipClassName),❌ 摆一个点了没反应的按钮。
   */
  lockedHint?: string;
}) {
  const { translate } = useSessionMessages();
  const ordered = orderMachines(machines);
  const selected = machines.find((m) => m.id === selectedId) ?? null;
  const hasOtherMachines = machines.some((m) => !m.isLocal);
  const compact = size === 'compact';
  // 规范:已记忆设备离线或不可用时**仍显示该设备和真实状态** ⇒ 标签直接用那台的名字,
  // ❌ 离线时改写成「本机」—— 那正是「静默回落」的观感版本。
  const label = selected
    ? selected.label
    : machines.length === 0
      ? translate('task.deviceNone')
      : translate('task.deviceSelect');
  const selectedOffline = selected !== null && !machineAcceptsWork(selected);
  // 与同类触发器同一个图标尺寸:托盘 12px(项目选择器),页标题旁 14px(项目顶栏的名字下拉)。
  const iconSize = compact ? 'size-3' : 'size-3.5';
  const sidebar = variant === 'sidebar';
  if (lockedHint && selected) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(sessionComposerTrayChipClassName, 'px-2 py-1')}
              data-testid={testId}
              data-size={size}
              data-locked="true"
              data-selected-id={selected.id}
            >
              <MachineKindIcon machine={selected} className={iconSize} />
              {!selected.isLocal ? <MachineDot machine={selected} /> : null}
              <span className="min-w-0 max-w-[160px] truncate">{selected.label}</span>
              {selectedOffline ? (
                <span data-slot="machine-offline" className="shrink-0 text-foreground-passive">
                  {translate('machinePicker.offline')}
                </span>
              ) : null}
            </span>
          }
        />
        <TooltipContent>{lockedHint}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          sidebar ? (
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-row-hover active:bg-row-press focus-visible:bg-row-hover data-popup-open:bg-row-selected"
              data-testid={testId}
              data-size="sidebar"
              data-selected-id={selected?.id ?? ''}
              title={selected?.hint ?? undefined}
            >
              <MachineTile machine={selected} solid />
              {/* 一行:名字。系统与连法只在菜单里 —— 两行会把这一列撑宽,和下面两个字的导航项之间空出一大片。 */}
              <span title={label} className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {label}
              </span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          ) : (
          <button
            type="button"
            className={compact ? sessionComposerTrayTriggerClassName : titleTriggerClassName}
            data-testid={testId}
            data-size={size}
            data-selected-id={selected?.id ?? ''}
            title={selected?.hint ?? undefined}
          >
            {selected ? (
              <MachineKindIcon machine={selected} className={iconSize} />
            ) : (
              <Monitor aria-hidden="true" className={cn('shrink-0', iconSize)} />
            )}
            {selected && !selected.isLocal ? <MachineDot machine={selected} /> : null}
            {/* 长名字截断,悬停看全名。 */}
            <span title={label} className={cn('min-w-0 truncate', compact ? 'max-w-[160px]' : 'max-w-[14rem]')}>
              {label}
            </span>
            {selectedOffline ? (
              <span data-slot="machine-offline" className="shrink-0 text-foreground-passive">
                {translate('machinePicker.offline')}
              </span>
            ) : null}
            <ChevronDown aria-hidden="true" className={cn('shrink-0', iconSize)} />
          </button>
          )
        }
      />
      {/* 菜单面与新建框的项目选择器同一副:min-w-64、p-0、列表 max-h-72 py-1。 */}
      <DropdownMenuContent
        side={side ?? (compact ? 'top' : 'bottom')}
        className={cn('p-0', sidebar ? 'min-w-56' : 'min-w-64')}
      >
        <div className="max-h-72 overflow-y-auto py-1">
          {sidebar ? (
            <div className="px-3 pt-2 pb-1 text-xs text-foreground-muted">{translate('machinePicker.menuLabel')}</div>
          ) : null}
          {ordered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">{translate('task.deviceEmpty')}</div>
          ) : (
            ordered.map((machine) => {
              const isSelected = machine.id === selected?.id;
              const offline = !machineAcceptsWork(machine);
              const rowMeta = machineMeta(machine, translate, { withLink: true });
              return (
                <DropdownMenuItem
                  key={machine.id}
                  data-device-id={machine.id}
                  data-online={offline ? 'false' : 'true'}
                  data-selected={isSelected ? 'true' : 'false'}
                  disabled={offline && !offlineSelectable}
                  // 选中那行用 kit 自己「已选」那一档(同 DropdownMenuRadioItem 的 data-checked);离线的退成 passive 字色。
                  className={cn(
                    sidebar && 'gap-3 py-1',
                    isSelected && !sidebar && 'bg-row-selected focus:bg-row-selected',
                    offline && offlineSelectable && 'text-foreground-passive'
                  )}
                  title={machine.isOnline || machine.cloudComputer ? (machine.hint ?? undefined) : undefined}
                  onClick={() => {
                    // #7199 选一台没醒着的云电脑 = 叫醒它(新建框里只在叫醒没成之后再点它时叫,见 wakeOnPick)。
                    if (machine.cloudComputer === 'wake-failed' || (wakeOnPick === 'always' && machine.cloudComputer)) {
                      void remoteHostsStore.wakeCloudComputer(machine.id);
                    }
                    onSelect(machine.id);
                  }}
                >
                  {sidebar ? (
                    <>
                      <MachineTile machine={machine} solid={false} />
                      <MachineLines label={machine.label} meta={rowMeta} muted={offline} />
                      {isSelected ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                    </>
                  ) : (
                    <MachineRow machine={machine} meta={rowMeta} />
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        {!hasOtherMachines ? (
          // 空状态:名下只有这一台。一句话说清别的机器是干嘛的,下面就是去添加的入口。
          <>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <div className="px-3 py-2 text-xs text-foreground-muted" data-testid="machine-picker-empty">
              {translate('task.deviceNoOtherMachines')}
            </div>
          </>
        ) : null}
        {onAddMachine ? (
          <>
            {hasOtherMachines ? <DropdownMenuSeparator className="mx-0 my-0" /> : null}
            <div className="py-1">
              <DropdownMenuItem onClick={onAddMachine} data-testid="machine-picker-add" className={cn(sidebar && 'gap-3 py-1')}>
                {sidebar ? (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border">
                    <Plus className="size-3.5" />
                  </span>
                ) : (
                  <Plus className="size-3.5" />
                )}
                <span className={cn(sidebar && 'text-foreground-muted')}>{translate('task.deviceAdd')}</span>
              </DropdownMenuItem>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
