import { pluginRegistry } from '@gugu/session-plugins/agents';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { getSessions } from '@main/core/sessions/getSessions';
import { GUGU_MCP_SERVER_NAME } from '../../../../mcp/gugu-mcp-name.mjs';
import { mcpService } from './services/McpService';
import { extensionsService } from '../extensions/extensions-root';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';

/**
 * #6387 The extension's name as the person knows it. The record holds only its id: the name is
 * looked up when the panel opens, and an extension uninstalled since the session started — whose
 * programs this session still has — is shown by its id.
 */
function extensionLabel(extensionId: string): { id: string; name: string } {
  try {
    return { id: extensionId, name: localizedManifestText(extensionsService().get(extensionId).manifest, sessionHostLocale()).name };
  } catch {
    return { id: extensionId, name: extensionId };
  }
}

export const mcpController = createRPCController({
  /**
   * `/mcp` 面板要的一整份:这条会话看得见哪几台、哪几台被用户关着、这家能不能关。
   *
   * ⚠️ **一次调用给全**,❌ 不让渲染层自己拼:拼的那一侧要知道
   * 「咕咕自己那台叫什么」「这家的方言是什么」「关掉的集合存在哪个键」——
   * 三样都是主进程的知识,漏一样的症状都是面板显示得**看起来对**而行为不对。
   */
  sessionPanel: async (sessionId: string) => {
    try {
      const session = (await getSessions()).find((c) => c.id === sessionId);
      if (!session) return { success: false, error: `session ${sessionId} not found` };
      const providerId = session.providerId;
      if (!providerId) return { success: false, error: `session ${sessionId} has no provider` };
      const provider = pluginRegistry.get(providerId);
      const toggle = provider?.capabilities?.sessionBundle?.mcpToggle;
      const dialect = toggle?.dialect ?? null;
      // 粒度缺省逐台 —— ❌ 不许缺省整组:那会让没声明的家静默多关几台。
      const granularity = toggle?.granularity ?? 'per-server';
      const all = await mcpService.listForAgent(providerId);
      const disabled = new Set(session.mcpDisabledServers ?? []);
      // The built-in server is not part of the user-configured registry or disabled set:
      // the agent needs it to send messages back. It is added below as a visible read-only row.
      const configured = all
        .map((server) => server.name)
        .filter((name) => name !== GUGU_MCP_SERVER_NAME);
      /**
       * ⚠️ 面板显示的是**事实**(这条正在跑的会话里有哪几台),❌ 不是意图
       * (下次起会带哪几台)。两者会分岔,而分岔的方向都是界面撒谎 ——
       * owner 2026-09-07 亲自撞到第一件:
       * ① 会话起来**之后**在全局装了一台新的 ⇒ 它不在关闭集合里,只按意图算会说「开着」,
       *    而这条会话的进程里根本没有它;
       * ② 反向更糟:会话起来之后**卸载**的那台从全局清单消失 ⇒ 整行不见,
       *    而它还在这个进程里活着、工具还调得动。用户以为卸了,其实没有。
       *
       * ⇒ 行取 **事实 ∪ 当下配置** 的并集(并集才盖得住②),开关状态取**事实**。
       *
       * 老会话没有这份事实(字段是后加的)⇒ 退回只按意图算,并在下一次重开时写实。
       * ❌ 不给横幅、不给 unknown 态:它会自愈,而一个解释不清的中间态比短暂的旧口径更糟。
       */
      // 关着的那几台也要在:分目录的层(Claude 的本地级 / 项目级)不在不带目录的 `configured` 里,
      // 关掉之后又不在 `started` 里 —— 少了这一格,它关掉就从面板上消失,再也开不回来。
      const started = session.mcpSessionServers;
      const userServers = started
        ? [...new Set([...started, ...configured, ...disabled])]
            .filter((name) => name !== GUGU_MCP_SERVER_NAME)
            .map((name) => ({
              name,
              enabled: started.includes(name),
            }))
        : configured.map((name) => ({ name, enabled: !disabled.has(name) }));
      // The built-in Gugu server is part of the same live MCP set shown by Pi's status bar,
      // but it is intentionally absent from the user-toggleable disabled set.
      // #6387 扩展交付进来的程序与技能:取会话起来那一刻记下的事实(扩展之后装卸/升级,
      // 这条会话仍是启动时那一版)。只读 —— 关掉某个扩展给 agent 的工具在扩展页,
      // ❌ 不在这里另开一个按会话的开关。
      const delivered = session.mcpSessionExtensions;
      const extensionServers = (delivered?.servers ?? []).map((server) => ({
        name: server.name,
        enabled: true,
        readOnly: true,
        extension: extensionLabel(server.extensionId),
      }));
      const skills = (delivered?.skills ?? []).map((skill) => ({
        name: skill.name,
        extension: extensionLabel(skill.extensionId),
      }));
      // 资源库 → MCP:读这一次起进程时记下的送达事实(`mcpSessionLibrary`),❌ 读「勾了」—— 勾了不等于送到了
      // (这条腿收不到、只收 http、和咕咕自己的撞了)。让给这一家自己的那台标在它自己那一行;其余没送的照样列一行写原因。
      // 只读:按会话关掉它们只有 Claude 认(codex / opencode 把能力包送进来的都当咕咕的),❌ 给一个在一半的家里不生效的开关。
      const fact = session.mcpSessionLibrary;
      const libraryServers = [
        ...(fact?.delivered ?? []).map((name) => ({ name, enabled: true, readOnly: true, library: 'delivered' as const })),
        ...(fact?.leftOut ?? [])
          .filter((item) => item.reason !== 'shadowed')
          .map((item) => ({ name: item.name, enabled: false, readOnly: true, library: item.reason, ...(item.with ? { libraryWith: item.with } : {}) })),
      ];
      const shadowed = new Set((fact?.leftOut ?? []).filter((item) => item.reason === 'shadowed').map((item) => item.name));
      const servers = [
        { name: GUGU_MCP_SERVER_NAME, enabled: true, readOnly: true },
        ...extensionServers,
        ...libraryServers,
        ...userServers.map((server) => (shadowed.has(server.name) ? { ...server, library: 'shadowed' as const } : server)),
      ];
      // dialect 原样带回:面板要用它决定「咕咕会接管整份清单」那句后果说不说 ——
      // ❌ 不在渲染层按 providerId 再判一次(那就是第二处方言知识)。
      return {
        success: true,
        data: { servers, skills, dialect, granularity, toggleSupported: dialect !== null, providerId },
      };
    } catch (error) {
      log.error('Failed to build the MCP session panel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  listForAgent: async (agentId: string) => {
    try {
      const data = await mcpService.listForAgent(agentId);
      return { success: true, data };
    } catch (error) {
      log.error('Failed to list MCP servers for agent:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

});
