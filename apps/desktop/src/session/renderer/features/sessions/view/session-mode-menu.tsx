import { observer } from 'mobx-react-lite';
import { AppWindow, Terminal, type IconComponent } from '@/lib/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { SessionView } from '@shared/core/sessions/sessions';
import { useSessionViewSwitch } from './session-actions';

/** 菜单里的一行:`lock` = 为什么选不了(给人看的原话),null = 选得了。 */
export interface SessionModeEntry {
  mode: SessionView;
  Icon: IconComponent;
  label: string;
  lock: string | null;
}

/**
 * 模式按钮(#7167):这一块页签条最右,编程 / 通用二选一。gugu-dev#181 去掉了「聊天」:没有项目的会话本身就是和它的
 * 私聊,项目里的会话直接在框里说,私聊页不再单独存在。owner 原型四轮定稿,三条规矩:
 *
 *  · **长相随全局,不另起**(owner「不要太显眼」「用力过猛」「需要和全局统一」):触发器照同一排「换模型」那颗
 *    (chat-composer.css.ts `agentTrigger`)—— 平时不铺底、次级灰字、不加粗、没箭头;悬浮浅底、开着淡蓝底。
 *    菜单就是会话页的单选下拉,宽度随内容。
 *  · **停一下就开**(owner「悬浮上去点一下也可以」):Base UI 的 openOnHover,直接点也开。
 *  · **换要多问一句**:切换为另一种展示 = 打断正在跑的那一轮、接着这条任务继续,走页签右键「切换为X模式」同一个
 *    确认框。选不了的那行变淡、停上去说原因(❌ 藏起来,❌ 点了没反应)。
 *  · **正在用的和动作分开**(owner 10-14「尽量不要让用户误触」):分隔线上面是正在用的那种(打勾),下面只有一个动作
 *    「切换为X模式」—— 与页签右键那一条同一句话、同一个确认框。两种并排成两行一样的单选时,「点它」和「换成它」
 *    长得一样,误触就出在这。代价只在动作被点下去时由确认框说。
 *
 * 页签条窄了只剩图标(index.css,同换模型那颗只剩厂商图形)。图标尺寸由页签条那条规则定,这里不写。
 */
export const SessionModeMenu = observer(function SessionModeMenu({ sessionId }: { sessionId: string }) {
  const { translate } = useSessionMessages();
  const viewSwitch = useSessionViewSwitch(sessionId);
  if (!viewSwitch) return null;

  const views: SessionModeEntry[] = [
    { mode: 'code', Icon: Terminal, label: translate('taskConfig.sessionViewCode'), lock: viewSwitch.lockOf('code') },
    { mode: 'general', Icon: AppWindow, label: translate('taskConfig.sessionViewGeneral'), lock: viewSwitch.lockOf('general') },
  ];
  return <SessionModeMenuView current={viewSwitch.view} views={views} onPick={(mode) => viewSwitch.request(mode)} />;
});

/**
 * 只管画:触发器 + 菜单。分隔线上面是正在用的那种(这一页就是它,打勾),下面是动作「切换为另一种」。
 * 选不了的行变淡、停上去说原因、点了不动(取数与动作在 SessionModeMenu)。
 */
export function SessionModeMenuView({
  current,
  views,
  onPick,
}: {
  /** 这条会话现在以哪种展示开(这一页就是它)。 */
  current: SessionView;
  /** 编程 / 通用两种,顺序不论 —— 正在用的那种打勾,另一种当动作。 */
  views: ReadonlyArray<SessionModeEntry>;
  onPick: (mode: SessionView) => void;
}) {
  const { translate } = useSessionMessages();
  const here = views.find((entry) => entry.mode === current)!;
  const other = views.find((entry) => entry.mode !== current)!;
  // 选不了的那行仍要接得住指针:原因挂在悬浮提示上,pointer-events-none 会让它永远停不上去。
  const lockedRow = 'data-disabled:pointer-events-auto data-disabled:cursor-default';
  const action = (
    <DropdownMenuItem
      key={other.mode}
      disabled={other.lock !== null}
      data-testid={`session-mode-${other.mode}`}
      className={cn('text-foreground-muted', lockedRow)}
      onClick={() => {
        if (other.lock === null) onPick(other.mode);
      }}
    >
      <other.Icon />
      {translate(other.mode === 'general' ? 'task.switchToGeneralView' : 'task.switchToCodeView')}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        openOnHover
        delay={100}
        closeDelay={200}
        data-testid="session-mode-trigger"
        aria-label={translate('task.modeMenu', { mode: here.label })}
        className={cn(
          'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-3',
          'border border-transparent text-[length:var(--font-body)] leading-none text-foreground-muted select-none',
          '!transition-[background-color,color] !duration-[var(--dur-fast)] ease-out motion-reduce:!transition-none',
          'outline-none hover:bg-row-hover hover:text-foreground data-popup-open:bg-row-selected data-popup-open:text-foreground',
          'focus-visible:border-border-primary'
        )}
      >
        <here.Icon />
        <span data-slot="session-mode-label">{here.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-24">
        <DropdownMenuRadioGroup value={current}>
          <DropdownMenuRadioItem value={here.mode} data-testid={`session-mode-${here.mode}`}>
            <here.Icon />
            {here.label}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {other.lock === null ? (
          action
        ) : (
          <Tooltip>
            <TooltipTrigger render={action} />
            <TooltipContent side="left">{other.lock}</TooltipContent>
          </Tooltip>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
