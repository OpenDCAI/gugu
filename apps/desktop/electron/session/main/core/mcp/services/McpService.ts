import { realpath } from 'node:fs/promises';
import type { IMcpBehavior, McpScopeDir } from '@gugu/session-core/agents/plugins';
import type { McpServer } from '@gugu/session-core/mcp';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { resolveAgentHomeRoot } from '@main/core/agents/agent-home';
import { createPluginFs } from '@main/core/agents/plugin-fs';
import { registrationToMcpServer } from '../utils/registration';

function mcpBehaviorOf(providerId: string): IMcpBehavior | null {
  const provider = pluginRegistry.get(providerId);
  if (!provider || provider.capabilities.mcp.kind !== 'supported') return null;
  return provider.behavior.mcp ?? null;
}

/** 那一家按真实路径记目录(Claude 的 `projects[]` 键):`/tmp` 起的会话在 macOS 上是 `/private/tmp`。 */
async function scopeDirs(dirs: readonly string[]): Promise<McpScopeDir[]> {
  const real = await Promise.all(dirs.map((dir) => realpath(dir).catch(() => dir)));
  return [...new Set(real)].map((dir) => ({ dir, fs: createPluginFs(dir) }));
}

export class McpService {
  /**
   * 这一家在 `cwd` 这个目录里开的会话会装载哪几台。`cwd` 不给 = 只有全局那一层(没有目录可言的调用方)。
   * 分目录的层按那一家自己的优先级盖过全局的同名那台(Claude:本地级 > 项目级 > 用户级;codex / opencode:项目层盖用户层)。
   * 停用的不在里面:这一家不会连它(Claude 在这个目录里 `/mcp` 关掉的、项目级被拒的,其余家的 `enabled = false`)。
   *
   * 读失败照原样抛出(复核三代 10-17):❌ 回 `[]` —— 调用方会把它记成「这条会话一台都没装」,
   * 而会话里那几台照样起着。
   */
  async listForAgent(agentId: string, cwd?: string): Promise<McpServer[]> {
    const mcp = mcpBehaviorOf(agentId);
    if (!mcp) return [];
    const fs = createPluginFs(await resolveAgentHomeRoot(agentId));
    const byName = new Map((await mcp.readServers(fs)).map((reg) => [reg.name, reg]));
    const scoped = cwd && mcp.readScopedServers ? await mcp.readScopedServers(fs, await scopeDirs([cwd])) : [];
    for (const kind of ['project', 'local'] as const) {
      for (const layer of scoped.filter((entry) => entry.kind === kind)) {
        for (const reg of layer.servers) byName.set(reg.name, reg);
      }
    }
    return [...byName.values()]
      .filter((reg) => reg.enabled !== false)
      .map((r) => registrationToMcpServer(r, [agentId]));
  }
}

export const mcpService = new McpService();
