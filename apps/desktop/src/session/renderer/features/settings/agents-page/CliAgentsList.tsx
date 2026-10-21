import React, { useMemo } from 'react';
import { useBusyInstallAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { useExpiredAgentIds } from '@renderer/lib/stores/use-agent-auth-status';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { Label } from '@renderer/lib/ui/label';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { AgentDetailModal } from './AgentDetailModal';
import { AgentTile } from './AgentTile';
import { resolveHarnessState } from './harness-state';
import { isManagedInstallOption } from './installation-sources';

const SectionLabel: React.FC<{ children: React.ReactNode; totalCount: number }> = ({
  children,
  totalCount,
}) => (
  <div className="px-3 py-2">
    <Label>
      {children}
      {` (${totalCount})`}
    </Label>
  </div>
);

/**
 * 一格都没有的时候说一句话。
 *
 * ❌ 之前这三个筛选下的空结果是**整片空白** —— 用户分不清「筛出来是空的」和「页面没加载
 * 出来」。形状与资源库扩展那张空态同一套(`ExtensionsSettingsCard` 的 `xp-empty`):
 * 左对齐一句弱化的话,搜索有词时把词说回来。
 */
const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-col items-start gap-1 px-3 pb-2 pt-7">
    <p className="m-0 text-sm text-foreground-muted">{children}</p>
  </div>
);

/** 推荐的三家在各自组里排最前 —— 只影响顺序,组头不再说「推荐」(owner 2026-09-22)。 */
const RECOMMENDED_IDS = new Set(['claude', 'codex', 'pi']);

type CliAgentsListProps = {
  searchQuery?: string;
  /**
   * 详情弹窗开在谁身上 —— **唯一**的那份事实,由资源库路由持有(见 library-view 的
   * `transientParams`)。这里从前另存了一份 `useState`,而关闭弹窗只写本地那份:路由里那个
   * agent 一直留着,下次进资源库又把弹窗打开。❌ 别再把它抄回组件里。
   */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
};

/**
 * 智能体页 = 图标网格(#6157)。
 *
 * ❌ 从前是一列行,每行行尾挂一到三枚文字徽标(「Chat UI」「有可用更新」「未安装」)。owner 拍板
 * 改成启动台的形状:「每个 harness 类似 app 的存在,管理界面可以以图标排布,就像一个个 app。」
 * 状态因此**画在图标上**(见 `AgentTile`),这里只负责排序与分组。
 *
 * ❌ 分组不再按四态读数切成三栏。状态已经画在格子上了,再用组头把同一件事说第二遍,就是
 * owner 说的那种「同一个事实在用户面上有六种说法」。分组只剩「已安装 / 未安装」两组(owner 2026-09-22),组内推荐的三家排前面。
 */
const AgentGrid: React.FC<{
  agents: AgentPayload[];
  busy: ReadonlySet<string>;
  /** #6264 此刻「登录已失效」的那几家 —— 图标上挂警示角标。 */
  expired: ReadonlySet<string>;
  onSelectAgent: (agentId: string) => void;
}> = ({ agents, busy, expired, onSelectAgent }) => (
  // auto-fill 而不是定死列数:弹层宽度随窗口变,格子跟着回流,❌ 不在某个宽度上留一条空带。
  <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1 px-2">
    {agents.map((agent) => (
      <AgentTile
        key={agent.id}
        agent={agent}
        busy={busy.has(agent.id)}
        signInExpired={expired.has(agent.id)}
        state={resolveHarnessState({
          reading: agent.reading,
          status: agent.status,
          busy: busy.has(agent.id),
          // 咕咕装不了的那一家不挂「有新版本」角标 —— 点进去也没有下一步(#6101 的形状)。
          updateAvailable: agent.updateAvailable && agent.installOptions.some(isManagedInstallOption),
        })}
        onClick={() => onSelectAgent(agent.id)}
      />
    ))}
  </div>
);

export const CliAgentsList: React.FC<CliAgentsListProps> = ({
  searchQuery = '',
  selectedAgentId,
  onSelectAgent,
}) => {
  const { data: agentPayloads } = useManagementAgents();
  const busy = useBusyInstallAgents();
  // 本机那份「登录已失效」只订阅不探;资源库看的是别的机器时不画(那台机器的读数在抽屉的「账号」一行)。
  const expired = useExpiredAgentIds(!useLibraryHost().remote);
  const { translate } = useSessionMessages();
  const normalizedQuery = searchQuery.toLowerCase();

  const visible = useMemo(
    () =>
      (agentPayloads ?? [])
        .filter((a) => !normalizedQuery || a.name.toLowerCase().includes(normalizedQuery))
        .sort(
          (a, b) =>
            Number(RECOMMENDED_IDS.has(b.id)) - Number(RECOMMENDED_IDS.has(a.id)) ||
            a.name.localeCompare(b.name),
        ),
    [agentPayloads, normalizedQuery]
  );

  /**
   * 两组:已安装 / 未安装(owner 2026-09-22:「一眼看不清哪些安装哪些没安装…改为已安装和未安装」)。
   *
   * 「装上了」读的是四态 `reading`(#6101):装了但起不来的那一家**在已安装组里**,挂警示角标。
   * ❌ 从前是 `status !== 'available'` 一刀切,它被并进「未安装」,用户照着去装第二份,而第一份
   * 还在 PATH 前面。
   */
  const installed = useMemo(() => visible.filter((a) => a.reading !== 'not-detected'), [visible]);
  const notInstalled = useMemo(() => visible.filter((a) => a.reading === 'not-detected'), [visible]);

  const query = searchQuery.trim();
  const emptyMessage =
    query === '' ? translate('agentsPage.emptyAll') : translate('agentsPage.noMatch', { query });

  return (
    <div className="pb-4">
      {visible.length === 0 && <EmptyState>{emptyMessage}</EmptyState>}
      {installed.length > 0 && (
        <div className="pt-4" data-testid="agent-group-installed">
          <SectionLabel totalCount={installed.length}>
            {translate('agentsPage.installed')}
          </SectionLabel>
          <AgentGrid agents={installed} busy={busy} expired={expired} onSelectAgent={onSelectAgent} />
        </div>
      )}
      {notInstalled.length > 0 && (
        // 组与组之间一条分界线 —— 这一页唯一欠的那种线(line budget)。
        <div
          className={installed.length > 0 ? 'mt-4 border-t pt-4' : 'pt-4'}
          data-testid="agent-group-not-installed"
        >
          <SectionLabel totalCount={notInstalled.length}>
            {translate('agentsPage.notInstalled')}
          </SectionLabel>
          <AgentGrid agents={notInstalled} busy={busy} expired={expired} onSelectAgent={onSelectAgent} />
        </div>
      )}
      <AgentDetailModal agentId={selectedAgentId} onClose={() => onSelectAgent(null)} />
    </div>
  );
};
