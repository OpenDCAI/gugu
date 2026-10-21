import type { CLIAgentPluginMetadata, CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import {
  asAgentProviderId,
  listUserExposedPlugins,
  pluginRegistry,
  type AgentProviderId,
} from '@gugu/session-plugins/agents';
import { shouldOfferUnsupportedAgents } from '@gugu/session-core/agents/plugins';
import { CLOUD_AGENT_TYPE, normalizeAgentType } from '@gugu/core/agentTypes';

export function getPlugin(id: string): CLIAgentPluginProvider {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin found for provider: ${id}`);
  return plugin;
}

export function getPluginMetadata(id: string): CLIAgentPluginMetadata {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin metadata found for provider: ${id}`);
  return plugin.metadata;
}

/**
 * 提供给用户挑选 / 安装的引擎列表 —— **两道闸都要过**，判据都在
 * `session-core/.../capabilities/support-tier.ts`：
 *
 *  · **支持档**（owner 2026-08-24「不支持的 agent 也不给用户用的空间了」）：
 *    acp + 模型网关 + plugin，三条缺一不可 —— 问的是「用户能不能驱动这家」。
 *  · **咕咕集成档**（owner 2026-08-25「没有适配的就先完全不加」）：
 *    咕咕的 MCP / env / 平台模型 / 身份自述 / 权限档五维都投递到了 —— 问的是
 *    「咕咕自己的那套东西在它上面都通吗」。
 *
 * 两个问题不是一个问题：一家可以「跑得起来、能用它自己的模型」，同时「咕咕的平台额度
 * 和权限分级在它上面一条都没接」。❌ 别把两条判据合成一条。
 *
 * ⚠️ 这里是**唯一**的收口：**三条**用户面都经这个函数 —— composer 的
 * `buildAgentPayloads` 与 `buildAgentMetadataList`，以及资源库 →「智能体」的
 * `buildManagementAgentPayloads`。
 *
 * #6099（owner 2026-09-21「29 家不上架的插件保留代码、先不上架」）：资源库从前另有一份
 * 投影（`listManagementPlugins()` 写死不看兜底开关，再把本机装了的 withheld 家补回来），
 * 于是同一台机器两个答案 —— mac1 真机资源库 21 行全 Installed、composer 7 家。
 * ⇒ ❌ 别再给任何一条用户面另开名单；兜底开关也一视同仁，只有它能把没上架的家列出来。
 *
 * ⚠️ 挡的是**新建的入口**，不是查表。`getPlugin(id)` / `pluginRegistry.get(id)` 照常解析所有
 * 已注册的家 —— 已经在用某家的会话必须继续跑得起来，❌ 别把这条线接到那两个上面去。
 */
export function listPlugins(): CLIAgentPluginProvider[] {
  return listUserExposedPlugins(shouldOfferUnsupportedAgents());
}

export type AgentCreationToolDescriptor = {
  id: string;
  engine: string;
  label: string;
  icon: string;
};

/** Renderer-facing projection of the same reachable set as listPlugins(). */
export function listAgentCreationTools(): AgentCreationToolDescriptor[] {
  return listPlugins().flatMap((provider) => {
    const engine = normalizeAgentType(provider.metadata.id);
    if (engine === CLOUD_AGENT_TYPE) return [];
    const icon = provider.assets.icon.variants[0]?.light;
    if (!icon) throw new Error(`Agent plugin '${provider.metadata.id}' has no selectable icon asset`);
    return [{ id: engine, engine, label: provider.metadata.name, icon }];
  });
}

export function isValidProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && pluginRegistry.get(value) !== undefined;
}

export function toAgentProviderId(value: string): AgentProviderId {
  if (!isValidProviderId(value)) throw new Error(`Unknown agent provider: ${value}`);
  return asAgentProviderId(value);
}
