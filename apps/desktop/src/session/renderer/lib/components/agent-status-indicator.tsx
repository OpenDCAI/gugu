import {
  presentAgentStatus,
  type AgentStatusPresentation,
} from '@gugu/core/shared/agentStatusPresentation';
import { CLISpinner } from '@renderer/lib/components/cliSpinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';

export type AgentIndicatorStatus = AgentStatus | null;

interface AgentStatusIndicatorProps {
  status: AgentIndicatorStatus;
  /** 附属态(spec agent-status-vocabulary):只改画法与那一句 —— 后台在跑静止、需要你写出在等什么。 */
  detail?: AgentStatusDetail | null;
  className?: string;
  disableTooltip?: boolean;
}

/**
 * 会话页一格 agent 状态。画成什么与聊天、手机同一个 `presentAgentStatus`(owner 2026-09-25 定表):
 * 运行中 = 转圈(字形不上色)、后台运行中 = 同一枚字形静止、需要你 = 黄点、出错了 = 红点;空闲不画(#6209)。
 * 颜色只引 tokens.css 的 `--agent-tone-*`,❌ 在会话页另拍一个琥珀 / 红。
 * ❌ 在这里画咕咕小鸟(#7243,owner 2026-10-15):任务页一屏同时在跑的会话多,每只小鸟每帧都要重画,开销随只数涨;
 * 小鸟只留在聊天与手机。
 */
export function AgentStatusIndicator({
  status,
  detail = null,
  className,
  disableTooltip,
}: AgentStatusIndicatorProps) {
  const { translate } = useSessionMessages();
  if (!status || status === 'idle') return null;
  const presentation = presentAgentStatus({ reading: { status, detail } });
  const label = translate(`agentStatus.${presentation.label}`);

  const indicator = (
    <span
      className="flex size-6 items-center justify-center"
      data-agent-status={status}
      data-status-detail={detail ?? undefined}
      data-agent-tone={presentation.tone}
    >
      <AgentStatusGlyph presentation={presentation} label={label} className={className} />
    </span>
  );

  if (disableTooltip) return indicator;

  return (
    <Tooltip>
      <TooltipTrigger render={indicator} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 一格状态的字形本身(侧栏行按自己的布局摆它,不带外壳与提示)。 */
export function AgentStatusGlyph({
  presentation,
  label,
  className,
  variant,
}: {
  presentation: AgentStatusPresentation;
  label: string;
  className?: string;
  variant?: '1' | '2';
}) {
  switch (presentation.tone) {
    case 'running':
    case 'parked':
      return (
        <span aria-label={label}>
          <CLISpinner variant={variant} animate={presentation.animate} />
        </span>
      );
    case 'needs_user':
      return (
        <span
          className={cn('rounded-full bg-[var(--agent-tone-needs-user)] size-2', className)}
          aria-label={label}
        />
      );
    case 'error':
      return (
        <span
          className={cn('rounded-full bg-[var(--agent-tone-error)] size-2', className)}
          aria-label={label}
        />
      );
    default:
      return null;
  }
}
