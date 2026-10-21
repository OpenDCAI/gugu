import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { LibraryMcpCheck, LibraryMcpHarnessServer, LibraryMcpServer } from '@shared/mcp-library';

/** 这一家自己的那几台,带着它的名字(段头「Claude Code 里配的」)。 */
export type McpHarnessGroup = { agent: AgentPayload; servers: LibraryMcpHarnessServer['server'][] };

/**
 * 资源库 → MCP 的数据:这台机器(资源库选的那台)上咕咕自己管的列表,以及装了的各家自己的用户级那几台。
 * 各家的只读(由那一家自己加载);检测它们的结果只留在这一页,不记下来 —— 那不是咕咕的记录。
 */
export function useMcpLibrary() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const listKey = ['mcpLibrary', host.key] as const;
  const reachable = host.remote?.online !== false;
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => host.mcpLibrary.list(),
    enabled: reachable,
    ...(host.remote ? { retry: false } : {}),
  });

  const agents = useManagementAgents();
  const installed = useMemo(
    () => (agents.data ?? []).filter((agent) => agent.reading !== 'not-detected').sort((a, b) => a.name.localeCompare(b.name)),
    [agents.data]
  );
  const providerIds = installed.map((agent) => agent.id);
  const harness = useQuery({
    queryKey: ['mcpLibrary', 'harness', host.key, providerIds],
    queryFn: () => host.mcpLibrary.harnessServers(providerIds),
    enabled: reachable && agents.data !== undefined,
    ...(host.remote ? { retry: false } : {}),
  });
  const groups: McpHarnessGroup[] = installed
    .map((agent) => ({
      agent,
      servers: (harness.data ?? []).filter((row) => row.providerId === agent.id).map((row) => row.server),
    }))
    .filter((group) => group.servers.length > 0);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: listKey });
  const add = useMutation({ mutationFn: (servers: LibraryMcpServer[]) => host.mcpLibrary.add(servers), onSettled: invalidate });
  const update = useMutation({ mutationFn: (server: LibraryMcpServer) => host.mcpLibrary.update(server), onSettled: invalidate });
  const remove = useMutation({ mutationFn: (name: string) => host.mcpLibrary.remove(name), onSettled: invalidate });
  const setEnabledByDefault = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => host.mcpLibrary.setEnabledByDefault(name, enabled),
    onSettled: invalidate,
  });

  // 正在检测的那几台(键 = `gugu:<名>` 或 `<家>:<名>`),以及各家那几台这一页上检测出来的结果。
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [harnessChecks, setHarnessChecks] = useState<Readonly<Record<string, LibraryMcpCheck>>>({});
  const track = async <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    setChecking((current) => new Set(current).add(key));
    try {
      return await work();
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return {
    servers: list.data ?? [],
    groups,
    // 各家那几组先问装了哪几家、再读配置:都回来之前也是「在读」,❌ 先画咕咕那组、各家的过一阵才冒出来。
    isLoading: list.isLoading || agents.isLoading || harness.isLoading,
    error: list.error ?? agents.error ?? harness.error,
    hasData: list.data !== undefined,
    reload: () => {
      void list.refetch();
      void harness.refetch();
    },
    isBusy: add.isPending || update.isPending || remove.isPending,
    add: add.mutateAsync,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
    setEnabledByDefault: (name: string, enabled: boolean) => setEnabledByDefault.mutate({ name, enabled }),
    checking,
    check: (name: string) => track(`gugu:${name}`, () => host.mcpLibrary.check(name)).finally(invalidate),
    harnessChecks,
    checkHarness: (providerId: string, name: string) =>
      track(`${providerId}:${name}`, async () => {
        const result = await host.mcpLibrary.checkHarnessServer(providerId, name);
        setHarnessChecks((current) => ({ ...current, [`${providerId}:${name}`]: result }));
        return result;
      }),
  };
}
