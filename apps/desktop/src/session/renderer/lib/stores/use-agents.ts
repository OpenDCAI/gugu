import { useQuery } from '@tanstack/react-query';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { queryClient } from '@renderer/lib/query-client';
import { LOCAL_HOST_KEY, useLibraryHost } from '@renderer/features/library/library-host';
import type { AgentIconAsset, AgentPayload } from '@shared/core/agents/agent-payload';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';

export const AGENTS_METADATA_QUERY_KEY = ['agents', 'metadata'] as const;

/** This machine's agent payloads change after boot when an ACP handshake reports fork (fork-legs.ts). */
export function wireAgentCapabilityInvalidation(): void {
  events.on(agentCapabilitiesChangedChannel, () => {
    void queryClient.invalidateQueries({ queryKey: AGENTS_METADATA_QUERY_KEY });
  });
}

/**
 * Fetches static agent metadata (name, description, icon, capabilities) for all agents.
 */
export function useAgents() {
  // #6264 会话 / 新建框在别的机器上:名单与装没装都是那台机器的(一套工作台,同一个控制器)。
  const remote = useLibraryHost().remote;
  const machine = remote?.deviceId ?? null;
  return useQuery<AgentPayload[]>({
    queryKey: machine ? [...AGENTS_METADATA_QUERY_KEY, 'remote', machine] : AGENTS_METADATA_QUERY_KEY,
    queryFn: () => rpcOn(machine).agents.list() as Promise<AgentPayload[]>,
    // 那台机器没连上就不问(手上有上次的就照旧画);连上时这里变回 true,过期了的当场重取 —— 机器回来,名单自己续上。
    enabled: remote?.online !== false,
    staleTime: machine ? 30_000 : 5 * 60 * 1000,
  });
}

export const MANAGEMENT_AGENTS_QUERY_KEY = ['agents', 'management'] as const;

/**
 * 资源库里某台机器的那份缓存键段:本机沿用原来的键(别处按它作废),别的机器多挂一段机器名,
 * ❌ 两台机器的读数落进同一格缓存(那就是拿这台电脑的读数冒充那台机器的)。
 */
function hostKey(key: string): readonly string[] {
  return key === LOCAL_HOST_KEY ? [] : ['host', key];
}

/**
 * 资源库 →「智能体」那张列表 —— 与 composer 同一份上架名单（#6099）。
 * #6264 资源库选了别的机器时,问的是那台机器(见 features/library/library-host.ts);离线时不问,手上有上次的就照旧画。
 */
export function useManagementAgents() {
  const host = useLibraryHost();
  return useQuery<AgentPayload[]>({
    queryKey: [...MANAGEMENT_AGENTS_QUERY_KEY, ...hostKey(host.key)],
    queryFn: () => host.agents.listManagement(),
    enabled: host.remote?.online !== false,
    staleTime: host.remote ? 30_000 : 5 * 60 * 1000,
    // 老 server 不认这个动词、机器问不通:原样交给页面说人话,❌ 自己再重试三遍把人晾一分钟。
    ...(host.remote ? { retry: false } : {}),
  });
}

/**
 * Fetches metadata for a single agent.
 */
export function useAgent(id: string) {
  return useQuery<AgentPayload | null>({
    queryKey: [...AGENTS_METADATA_QUERY_KEY, id, 'local'],
    queryFn: () => rpc.agents.get(id) as Promise<AgentPayload | null>,
    staleTime: 5 * 60 * 1000,
  });
}

export function useManagementAgent(id: string) {
  const host = useLibraryHost();
  return useQuery<AgentPayload | null>({
    queryKey: [...MANAGEMENT_AGENTS_QUERY_KEY, id, host.key],
    queryFn: () => host.agents.getManagement(id),
    enabled: host.remote?.online !== false,
    staleTime: host.remote ? 30_000 : 5 * 60 * 1000,
    ...(host.remote ? { retry: false } : {}),
  });
}

export const AGENT_ICONS_QUERY_KEY = ['agents', 'icons'] as const;

/**
 * 图标表:**每个注册过的家**都有一份,与「上架给用户挑」那两道闸无关。
 *
 * ❌ 别改回从 `useAgents()`(= `agents.list()`)里按 id 找 —— 那份名单是「能不能新建」的闸,
 * 本机装了但没上架的家(Amp / Grok / Kimi / Qoder…)不在里面,于是资源库的智能体列表、侧栏会话行、
 * 会话标签、MCP 卡片上这些家全都画不出图标(owner 2026-09-15)。图标是查表,不是入口。
 */
export function useAgentIcons() {
  return useQuery<Record<string, AgentIconAsset>>({
    queryKey: AGENT_ICONS_QUERY_KEY,
    queryFn: () => rpc.agents.listIcons() as Promise<Record<string, AgentIconAsset>>,
    staleTime: Infinity,
  });
}

/** Returns the icon asset for any registered agent, installed and offered or not. */
export function useAgentIcon(id: string) {
  const { data: icons } = useAgentIcons();
  return icons?.[id] ?? null;
}
