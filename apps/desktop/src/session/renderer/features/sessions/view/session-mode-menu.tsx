import { observer } from 'mobx-react-lite';
import { useState, type ReactElement } from 'react';
import { AppWindow, MessageCircle, Terminal, type IconComponent } from '@/lib/icons';
import { toast } from '@renderer/lib/hooks/use-toast';
import { log } from '@renderer/utils/logger';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { shellPort } from '@renderer/lib/shell-port';
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
import { useSessionViewContext } from '../session-view-context';
import { useSessionAgentCard } from '../use-session-agent-card';
import { useSessionViewSwitch } from './session-actions';

export type SessionMode = 'chat' | SessionView;

/** 菜单里的一行:`lock` = 为什么选不了(给人看的原话),null = 选得了。 */
export interface SessionModeEntry {
  mode: SessionMode;
  Icon: IconComponent;
  label: string;
  lock: string | null;
}

/**
 * 模式按钮(#7167):这一块页签条最右,一颗切三种 —— 聊天 / 编程 / 通用。聊天页头部同一颗(咕咕那棵树里,
 * AgentSessionpagePresentation)。owner 原型四轮定稿,三条规矩:
 *
 *  · **长相随全局,不另起**(owner「不要太显眼」「用力过猛」「需要和全局统一」):触发器照同一排「换模型」那颗
 *    (chat-composer.css.ts `agentTrigger`)—— 平时不铺底、次级灰字、不加粗、没箭头;悬浮浅底、开着淡蓝底。
 *    菜单就是会话页的单选下拉,宽度随内容(❌ 照抄「排序方式」那份 min-w-48,三个两字的名字撑不满,名字和勾
 *    之间空一大截 —— owner「看着又不精致」)。
 *  · **停一下就开**(owner「悬浮上去点一下也可以」):Base UI 的 openOnHover,直接点也开。
 *  · **便宜的直接做,贵的多问一句**:聊天 = 去这条任务的私聊(没私聊过就在这一下开);切换为另一种展示 = 打断
 *    正在跑的那一轮、接着这条任务继续,走页签右键「切换为X模式」同一个确认框。选不了的那行变淡、停上去说原因(❌ 藏起来,❌ 点了没反应)。
 *  · **去处和动作分开**(owner 10-14「编程和通用一般是二选一」「尽量不要让用户误触…去聊天是挺频繁的,编程和
 *    通用的切换没那么频繁」):菜单里其实是两件事 —— **看哪儿**(聊天 / 这条任务)随便去、不打断什么;**任务怎么跑**
 *    (编程 / 通用)一次只有一种,换要打断正在跑的那一轮。所以分隔线上面是两个去处:聊天、正在用的那种(打勾);
 *    下面只有一个动作「切换为X模式」—— 与页签右键那一条同一句话、同一个确认框。正在用的那种不再和另一种并排成
 *    两行一样的单选:并排时「点它」和「换成它」长得一样,owner 说的误触就出在这。
 *    ❌ 在两行上面挂一行「切换会重启任务」:罩住了正在用的那行(点它什么都不发生),而且代价说错了 —— 不是重启,
 *    是打断这一轮、接着这条任务继续(确认框原话)。代价只在动作被点下去时由确认框说(owner 10-14「太偷懒…不对」)。
 *
 * 页签条窄了只剩图标(index.css,同换模型那颗只剩厂商图形)。图标尺寸由页签条那条规则定,这里不写。
 */
export const SessionModeMenu = observer(function SessionModeMenu({ sessionId }: { sessionId: string }) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const viewSwitch = useSessionViewSwitch(sessionId);
  const card = useSessionAgentCard(sessionId);
  const [openingChat, setOpeningChat] = useState(false);
  if (!viewSwitch) return null;

  const current = viewSwitch.view;
  const chat: SessionModeEntry = {
    mode: 'chat',
    Icon: MessageCircle,
    label: translate('task.modeChat'),
    lock: card ? null : translate('task.modeChatNeedsIdentity'),
  };
  const views: SessionModeEntry[] = [
    { mode: 'code', Icon: Terminal, label: translate('taskConfig.sessionViewCode'), lock: viewSwitch.lockOf('code') },
    { mode: 'general', Icon: AppWindow, label: translate('taskConfig.sessionViewGeneral'), lock: viewSwitch.lockOf('general') },
  ];
  const openChat = async () => {
    if (openingChat) return;
    setOpeningChat(true);
    try {
      // 找到(没有就开)这个 Agent 的私聊,再把咕咕切过去 —— 与对话页建任务的收尾同一条路。
      const address = await shellPort().ensureAgentAddress({ projectId, sessionId });
      sessionpageMessageHost().openAgentChat(address);
    } catch (error) {
      // 原文只进日志;人看到的是能照做的那一句(user-copy-leak-check)。
      log.error('[sessionpage] 模式按钮开私聊失败', { sessionId, error: error instanceof Error ? error.message : String(error) });
      toast({ title: translate('task.modeChatOpenFailed'), tier: 'error' });
    } finally {
      setOpeningChat(false);
    }
  };

  const pick = (mode: SessionMode) => {
    if (mode === current) return;
    if (mode === 'chat') void openChat();
    else viewSwitch.request(mode);
  };

  return <SessionModeMenuView current={current} chat={chat} views={views} chatBusy={openingChat} onPick={pick} />;
});

/**
 * 只管画:触发器 + 菜单。分隔线上面是去处(聊天、正在用的那种 —— 这一页就是它,打勾),下面是动作「切换为另一种」。
 * 选不了的行变淡、停上去说原因、点了不动(取数与动作在 SessionModeMenu)。
 */
export function SessionModeMenuView({
  current,
  chat,
  views,
  chatBusy,
  onPick,
}: {
  /** 这条会话现在以哪种展示开(这一页就是它)。 */
  current: SessionView;
  chat: SessionModeEntry;
  /** 编程 / 通用两种,顺序不论 —— 正在用的那种当去处,另一种当动作。 */
  views: ReadonlyArray<SessionModeEntry>;
  /** 正在开私聊:「聊天」那行先不接第二下。 */
  chatBusy: boolean;
  onPick: (mode: SessionMode) => void;
}) {
  const { translate } = useSessionMessages();
  const here = views.find((entry) => entry.mode === current)!;
  const other = views.find((entry) => entry.mode !== current)!;
  const withReason = (mode: SessionMode, lock: string | null, item: ReactElement) =>
    lock === null ? (
      item
    ) : (
      <Tooltip key={mode}>
        <TooltipTrigger render={item} />
        <TooltipContent side="left">{lock}</TooltipContent>
      </Tooltip>
    );
  // 选不了的那行仍要接得住指针:原因挂在悬浮提示上,pointer-events-none 会让它永远停不上去。
  const lockedRow = 'data-disabled:pointer-events-auto data-disabled:cursor-default';
  const place = ({ mode, Icon, label, lock }: SessionModeEntry) => {
    const locked = lock !== null && mode !== current;
    return withReason(
      mode,
      locked ? lock : null,
      <DropdownMenuRadioItem
        key={mode}
        value={mode}
        disabled={locked || (mode === 'chat' && chatBusy)}
        data-testid={`session-mode-${mode}`}
        className={lockedRow}
        onClick={() => {
          if (!locked) onPick(mode);
        }}
      >
        <Icon />
        {label}
      </DropdownMenuRadioItem>
    );
  };
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
          {place(chat)}
          {place(here)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {withReason(
          other.mode,
          other.lock,
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
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
