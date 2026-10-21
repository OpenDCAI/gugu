import type { ReactNode } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 项目行的零件:本机项目行(project-item)与别的机器上的项目行(#6264,sidebar-remote-project-item)共用,
// 两种行长得一样只因为用的是同一份零件。

/**
 * spec session-page 链6: 收起的项目行上,「有会话在等你」的那颗琥珀点。本机与别的机器上的项目行同一颗。
 */
export function ProjectNeedsYouDot({ count }: { count: number }) {
  const { translate } = useSessionMessages();
  if (count <= 0) return null;
  const label = translate('sidebar.sessionsNeedYou', { count });
  return (
    <span
      aria-label={label}
      title={label}
      className="size-1.5 shrink-0 rounded-[var(--radius-circle,50%)] bg-foreground-warning"
    />
  );
}

/** 项目名 + 挨着它的次级信息(本机:同名歧义的路径 / 告警图标;别的机器:机器名 / 离线)。 */
export function ProjectRowTitle({ name, children }: { name: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="max-w-full shrink-0 truncate">{name}</span>
      {children}
    </span>
  );
}
