import { messageForUser } from '@/lib/userFacingError';
import { Plus } from '@/lib/icons';
import React from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { LibraryMcpServer } from '@shared/mcp-library';
import { McpLibraryRow } from './mcp-library-row';
import { useMcpLibrary } from './use-mcp-library';

/** 卡片面与资源库其它格同一套(`border-border bg-background-1`),组与组之间的距离大于组内标题到卡片。 */
const CARD = 'divide-y divide-foreground/10 overflow-hidden rounded-lg border border-border bg-background-1';

/**
 * 资源库 → MCP(owner 10-18「仿照 aionui 的那种管理机制」+「用户全局配置直接和咕咕的共存」):
 * 上面是咕咕自己管的那份列表(加 / 改 / 删 / 默认启用 / 检测),下面按家列各家自己的用户级那几台(只读、可检测)。
 * 新建任务时勾选的只有咕咕的那几台;各家自己的照常由那一家自己带上。
 */
export const McpLibraryView: React.FC = () => {
  const library = useMcpLibrary();
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const showServerModal = useShowModal('mcpServerModal');
  const showConfirm = useShowModal('confirmActionModal');
  const notice = deviceScopeNotice(
    { remote: host.remote, error: library.error, hasData: library.hasData, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );
  const disabled = library.isBusy || !!notice?.readOnly;
  const harnessNames: Record<string, string[]> = {};
  for (const group of library.groups) {
    for (const server of group.servers) (harnessNames[server.name] ??= []).push(group.agent.name);
  }
  const fail = (failure: unknown) => {
    log.error('library MCP action failed', { error: String(failure) });
    toast({ title: messageForUser(failure), variant: 'destructive' });
  };

  const openAdd = () =>
    showServerModal({
      existing: library.servers,
      harnessNames,
      onSuccess: (servers) => void library.add(servers.map((server) => ({ ...server, enabledByDefault: true }))).catch(fail),
    });
  const openEdit = (server: LibraryMcpServer) =>
    showServerModal({
      initial: server,
      existing: library.servers,
      harnessNames,
      onSuccess: ([edited]) => edited && void library.update({ ...edited, enabledByDefault: server.enabledByDefault }).catch(fail),
    });
  const confirmDelete = (server: LibraryMcpServer) =>
    showConfirm({
      title: translate('mcpLibrary.delete', { name: server.name }),
      description: translate('mcpLibrary.deleteDescription'),
      confirmLabel: translate('mcpLibrary.deleteConfirm'),
      onSuccess: () => void library.remove(server.name).catch(fail),
    });

  return (
    <TooltipProvider delay={150}>
      <div data-slot="mcp-library" className="flex flex-col text-foreground">
        <PageHeader
          sticky
          title={translate('mcpLibrary.title')}
          description={translate('mcpLibrary.subtitle')}
        >
          <div className="flex w-full justify-end gap-2">
            <Button onClick={openAdd} disabled={disabled} aria-label={translate('mcpLibrary.add')}>
              <Plus className="size-4" />
              <span className="[@container(max-width:520px)]:hidden">{translate('mcpLibrary.add')}</span>
            </Button>
          </div>
        </PageHeader>
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={library.reload} />}
        {library.isLoading ? (
          <PageLoading />
        ) : notice && !library.hasData ? null : (
          <div className="flex flex-col gap-6 py-8">
            <section data-slot="mcp-library-gugu" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{translate('mcpLibrary.ownGroup')}</h3>
              <div className={CARD}>
                {library.servers.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-foreground-muted">{translate('mcpLibrary.ownEmpty')}</div>
                ) : (
                  library.servers.map((server) => (
                    <McpLibraryRow
                      key={server.name}
                      server={server}
                      check={server.check}
                      checking={library.checking.has(`gugu:${server.name}`)}
                      disabled={disabled}
                      enabledByDefault={server.enabledByDefault}
                      onCheck={() => void library.check(server.name).catch(fail)}
                      onToggleDefault={(enabled) => library.setEnabledByDefault(server.name, enabled)}
                      onEdit={() => openEdit(server)}
                      onDelete={() => confirmDelete(server)}
                    />
                  ))
                )}
              </div>
            </section>
            {library.groups.map(({ agent, servers }) => (
              <section key={agent.id} data-slot="mcp-library-harness" data-provider-id={agent.id} className="flex flex-col gap-2">
                <header className="flex min-h-7 items-center gap-2">
                  <AgentIcon id={agent.id} size={20} className="shrink-0 rounded-sm" />
                  {/* @@@raw agent name — harness 名是 provider 数据,原样显示。 */}
                  <h3 className="text-sm font-medium text-foreground">{translate('mcpLibrary.harnessGroup', { agent: agent.name })}</h3>
                </header>
                <div className={CARD}>
                  {servers.map((server) => (
                    <McpLibraryRow
                      key={server.name}
                      server={server}
                      check={library.harnessChecks[`${agent.id}:${server.name}`]}
                      checking={library.checking.has(`${agent.id}:${server.name}`)}
                      disabled={disabled}
                      harnessName={agent.name}
                      onCheck={() => void library.checkHarness(agent.id, server.name).catch(fail)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
};
