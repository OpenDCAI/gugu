import { RefreshCw } from '@/lib/icons'
import React, { useCallback, useState } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { useAgentInstallationStatuses } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { CliAgentsList } from './CliAgentsList';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

export function AgentsSettingsPage({
  selectedAgentId,
  onSelectAgent,
}: {
  /** 当前打开详情的 agent;由路由(资源库 view params)持有,本页只读它、点行时回写。 */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const { probeAll } = useAgentInstallationStatuses();
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const agents = useManagementAgents();
  /**
   * 看的是别的机器、而它此刻给不出东西(离线 / server 太旧 / 问不通):说一句人话。
   * 手上有它上次的读数就照旧画(离线时只读);一份都没有就只有这句话 —— ❌ 画一句「这里还没有智能体」。
   */
  const notice = deviceScopeNotice(
    { remote: host.remote, error: agents.error, hasData: !!agents.data, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    probeAll(undefined, {
      onSettled: () => setRefreshing(false),
    });
  }, [probeAll]);

  return (
    <>
      <PageHeader
        sticky
        title={translate('settings.agents')}
      >
        <div className="flex items-center justify-end gap-2">
          {/* ❌ 这里曾有「全部 / 已安装 / 未安装」三段筛选。网格本身已经分成「已安装」「未安装」
              两组(owner 2026-09-22),再摆一排同样三个词就是同一个事实说两遍。 */}
          <div className="flex items-center gap-2">
            <SearchInput
              placeholder={translate('composer.searchAgents')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              containerClassName="w-56"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => void handleRefresh()}
              disabled={refreshing || !!notice?.readOnly}
              aria-label={translate('settings.refreshAgents')}
            >
              {refreshing ? <LoadingIndicator size="inline" /> : <RefreshCw />}
            </Button>
          </div>
        </div>
      </PageHeader>
      {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void agents.refetch()} />}
      {agents.isLoading ? (
        <PageLoading />
      ) : notice && !agents.data ? null : (
        <div className="flex flex-col gap-3">
          <CliAgentsList
            searchQuery={searchQuery}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
          />
        </div>
      )}
    </>
  );
}
