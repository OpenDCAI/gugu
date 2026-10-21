import { AlertTriangle, ArrowUp } from '@/lib/icons';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { readingLabelKey } from '@renderer/lib/components/agent-availability-groups';
import { useAgentInstallProgress } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { cn } from '@renderer/utils/utils';
import { InstallProgressRing } from './InstallProgressRing';
import { installProgressRatio } from './install-progress-line';
import type { HarnessState } from './harness-state';

/**
 * 网格里的一格 = 一家 harness,像启动台里的一个 App(#6157)。
 *
 * owner 原话:「每个 harness 类似 app 的存在,管理界面可以以图标排布,就像一个个 app。」
 * 所以状态**画在图标上**,不再是行尾一枚文字徽标:未装灰化、有新版本角标、装了但起不来警示角标、
 * 安装中一圈进度环。❌ 别把词再写回格子里 —— 三十四家里三十二家没装,同一句「未安装」在一屏里
 * 重复三十二遍不是信号是噪声(这条账在 `agent-availability-groups` 的注释里)。
 *
 * 词只留在**读屏**那一路(`aria-label`):四态的说法与 composer 分组头、手机端行尾原因共用
 * 那一张表(`readingLabelKey`),❌ 不在这儿另起一套。
 */
export function AgentTile({
  agent,
  state,
  busy,
  signInExpired = false,
  onClick,
}: {
  agent: AgentPayload;
  state: HarnessState;
  /**
   * #6264 这家在这台机器上的登录已失效(凭据还在、真用时被拒)。与「装了但起不来」同一枚警示角标 ——
   * 都是「有东西要处理」;点开抽屉,「账号」一行写着「登录已失效」并给「重新登录」。
   */
  signInExpired?: boolean;
  /** 正在装 / 正在更新 —— 由列表一次问出来(`useBusyInstallAgents`),❌ 每格各问一遍。 */
  busy: boolean;
  onClick: () => void;
}) {
  const { translate } = useSessionMessages();
  const progress = useAgentInstallProgress(agent.id, busy);
  const ratio = installProgressRatio(progress);
  // 有新版本与警示互斥(一个角只放一枚):要处理的事排在「可以往前走一步」前面。
  const warn = state === 'broken' || (signInExpired && state !== 'not-installed' && state !== 'installing');

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`agent-tile-${agent.id}`}
      data-state={state}
      // @@@raw agent name — agent 名是 provider 数据,只做插值。
      aria-label={`${agent.name} — ${translate(readingLabelKey(agent.reading))}${
        warn && signInExpired ? ` · ${translate('agentsPage.accountExpired')}` : ''
      }`}
      className="group flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg px-1 pt-3 pb-2 text-center outline-none hover:bg-row-hover focus-visible:bg-row-hover"
    >
      {/* 图标本身就是一块满底色的 App 图标(`AppIcon`)。❌ 不再是浅底方块里居中一个小标识 ——
          owner 2026-09-22:「不是空空的空白加一个居中图标」。未安装 = 整块灰化退后。 */}
      <span className="relative flex size-14 shrink-0 items-center justify-center">
        <AppIcon id={agent.id} size={56} dimmed={state === 'not-installed' || state === 'installing'} />
        {state === 'installing' && <InstallProgressRing ratio={ratio} />}
        {/* 角标压在图标右上角。两枚互斥:有新版本是「可以往前走一步」,起不来是「有东西要处理」。
            ⚠️ testid **不能**以 `agent-tile-` 开头:取证脚本按那个前缀数格子,角标会被数成
            第八个智能体(真机取证时实撞到,读出一个 id 叫 `warning-badge` 的「智能体」)。 */}
        {state === 'update-available' && !warn && (
          <span
            data-testid="tile-state-badge-update"
            className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background"
          >
            <ArrowUp className="size-3.5" />
          </span>
        )}
        {warn && (
          <span
            data-testid="tile-state-badge-warning"
            className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-background text-foreground-warning ring-2 ring-background"
          >
            <AlertTriangle className="size-4" />
          </span>
        )}
      </span>
      {/* 名字两行封顶:「GitHub Copilot」这类长名字在一行里会被截成认不出的样子。 */}
      <span
        className={cn(
          'line-clamp-2 text-[length:var(--font-body)] leading-tight',
          state === 'not-installed' ? 'text-foreground-passive' : 'text-foreground',
        )}
      >
        {agent.name}
      </span>
    </button>
  );
}
