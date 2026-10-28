import { Folder, Monitor, Server } from '@/lib/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';

// owner 10-28:会话列表、项目行都不标机器(机器只在悬停卡里写;跨机器的项目行留「N 台设备」)。
// 这里只剩两样小图标:群文件夹里的文件存在哪台机器上(FileHostMark),挂在父会话下、在别的项目里的 child 的项目标记。

/**
 * The machine mark itself, wherever something says which machine it is on (a task's row, a project chat's file): an icon
 * only, in the faintest ink — Monitor for this computer, Server for another — and everything else said on hover.
 */
export function HostMark({ local = false, label, dimmed = false, long = false, ...data }: {
  local?: boolean; label: string; dimmed?: boolean; /** A sentence rather than a name: the hover wraps. */ long?: boolean;
} & { [key: `data-${string}`]: string }) {
  const Icon = local ? Monitor : Server;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span {...data} aria-label={label} className="text-foreground-tertiary-passive flex shrink-0 items-center">
            <Icon className={cn('size-3', dimmed && 'opacity-60')} />
          </span>
        }
      />
      <TooltipContent className={long ? 'max-w-72' : 'whitespace-nowrap'}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 挂在父会话下、却在别的项目里的会话,行首那枚项目标记(与机器标记同一个形状,悬停出项目名)。 */
export function ProjectBadge({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span data-project-badge={label} aria-label={label} className="text-foreground-tertiary-passive flex shrink-0 items-center">
            <Folder className="size-3" />
          </span>
        }
      />
      <TooltipContent className="whitespace-nowrap">{label}</TooltipContent>
    </Tooltip>
  );
}
