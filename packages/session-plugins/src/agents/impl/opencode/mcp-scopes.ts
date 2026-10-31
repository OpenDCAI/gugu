import type { IMcpBehavior, McpScopedServers } from '@gugu/session-core/agents/plugins';
import { opencodeMcpAdapter } from './mcp';

/**
 * OpenCode 的 MCP 照它**文档写的合并顺序**读文件(https://opencode.ai/docs/config/「Locations」「Precedence order」):
 * 全局 `~/.config/opencode/opencode.json(c)` → 项目 `<目录>/opencode.json(c)`;多份是**合并**,冲突的键后者胜。
 *
 * ❌ 不让它自己列(`opencode debug config`):那会起一个完整实例,执行项目 `.opencode/` 下与配置里声明的插件
 * (复核三代读 v1.18.25 源码确认)—— 打开资源库就等于在每个项目目录里执行一遍别人的插件。
 *
 * 只读到这个目录这一层:文档说它会从当前目录往上找到最近的 Git 目录,资源库给的目录是项目根与任务工作区,
 * 往上那几层没有读(未核)。远端 / `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / 托管配置也没有读(未核)。
 */
export function opencodeScopedMcpAdapter(): IMcpBehavior {
  const global = opencodeMcpAdapter();
  // 同一份方言(type:'local'/'remote'、command 数组、environment),只是以项目目录为根。
  const project = opencodeMcpAdapter('opencode.json', [], ['opencode.jsonc']);
  return {
    ...global,
    async readScopedServers(fs, dirs) {
      const byName = new Map((await global.readServers(fs)).map((reg) => [reg.name, reg]));
      const scoped: McpScopedServers[] = [];
      for (const { dir, fs: dirFs } of dirs) {
        // 合并到字段:项目里只写 `{ "enabled": false }` 也是把全局那台关掉(文档的 Remote 一节正是这个例子)。
        const servers = (await project.readServers(dirFs)).map((reg) => ({ ...byName.get(reg.name), ...reg }));
        if (servers.length > 0) scoped.push({ kind: 'project', dir, servers });
      }
      return scoped;
    },
  };
}
