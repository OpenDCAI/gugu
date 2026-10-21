import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { IMcpBehavior, McpScopedServers, McpServerRegistration, PluginFs } from '@gugu/session-core/agents/plugins';
import { readJsoncObject } from '@gugu/session-core/agents/plugins/helpers';
import { geminiFamilyNativeToRegistration } from '../../helpers/gemini-family-mcp';
import { qwenMcpAdapter } from './mcp';

/**
 * Qwen Code 的 MCP 照它**自己的拼法**读文件(出处:@qwen-code/qwen-code 0.24.4 发行字节,源文件名照 bundle 里的注释):
 *
 * - 层与优先级(`packages/cli/src/config/mcpServers.ts` `assembleMcpServers`,同名整条后者胜):
 *   用户 `~/.qwen/settings.json` 的 `mcpServers` < 项目 `<目录>/.mcp.json`(Claude 格式,经 `normalizeClaudeMcpServer`)
 *   < 工作区 `<目录>/.qwen/settings.json` 的 `mcpServers`。
 * - 批准(`packages/cli/src/config/mcpApprovals.ts`):项目与工作区两层要批准(`isGatedMcpScope`)。记录在
 *   `~/.qwen/mcpApprovals.json`(`QWEN_CODE_MCP_APPROVALS_PATH` 可改,这里没读 —— 未核),键是目录的绝对路径
 *   (Windows 小写),值 `{ hash, status }`;没有记录、或 hash 与当前配置对不上(改过配置要重新批准)= 待批准,
 *   否则照 `status`(approved / rejected)。连不连看开会话时的档位(`loadCliConfig`:`approvalMode === "yolo"`
 *   时没有待批准集;`getPendingGatedMcpServers` 收的是所有不是 approved 的,待批准与被拒一起):档位是 yolo 时
 *   待批准的、被拒的都连;其余档位都不连(`describeSkippedConnectionReason`「server is pending approval」)。
 *   yolo 来自 `--approval-mode=yolo`、`--yolo`,或受信任目录里 settings 的 `tools.approvalMode: "yolo"`。
 *   咕咕的聊天腿起 qwen 只带 `--acp`(档位开起来以后经 ACP 设),没有那条 settings 时开会话的档位是 auto
 *   (10-18 mac1 实测：「完全访问」的聊天任务里已批准的起了，待批准、被拒的都没起)⇒ 只算已批准的。
 *   没区分(记成停用，实际在连):终端腿「完全访问」(带 `--approval-mode=yolo`);用户 settings 把默认档写成 yolo。
 *   没核:settings 热重载(`registerMcpHotReload`)按**当时的**档位重算批准集 —— 聊天腿经 ACP 设成 yolo 以后
 *   会话中途改了 settings,待批准、被拒的可能被热连上。
 * - hash(`packages/core/src/mcp/configHash.ts` `hashMcpServerConfig`):去掉 `scope` / `extensionName` / `description`,
 *   对象键逐层排序后 JSON.stringify,再 sha256。
 * - 排除:`mcp.excluded`(用户与工作区两份 settings,名字或带 `*` `?` 的模式)= 不连。
 *
 * 没有读的(未核):系统级 settings、扩展带的 server、`mcp.allowed` 白名单、settings 里的逐台停用、目录信任。
 */

const NON_BEHAVIORAL_FIELDS = new Set(['scope', 'extensionName', 'description']);

function hashMcpServerConfig(config: Record<string, unknown>): string {
  const behavioral = Object.fromEntries(Object.entries(config).filter(([key]) => !NON_BEHAVIORAL_FIELDS.has(key)));
  const stable = JSON.stringify(behavioral, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
    }
    return value;
  });
  return createHash('sha256').update(stable).digest('hex');
}

/** qwen 的 `normalizeClaudeMcpServer`:`.mcp.json` 的 Claude 写法换成 qwen 自己的(`type:'http'` + `url` → `httpUrl`)。 */
function normalizeClaudeMcpServer(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.command || raw.httpUrl || raw.tcp) {
    if (raw.type === undefined || raw.type === 'sdk') return raw;
    const { type: _type, ...rest } = raw;
    return rest;
  }
  if (typeof raw.url === 'string') {
    const { url, ...rest } = raw;
    if (rest.type !== 'sdk') delete rest.type;
    return { ...rest, ...(raw.type === 'http' ? { httpUrl: url } : { url }) };
  }
  return raw;
}

/** qwen 的 `matchesServerPattern`:只有 `*` 与 `?` 两种通配。 */
function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return name === pattern;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return regex.test(name);
}

function serversOf(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        entry[1] !== null && typeof entry[1] === 'object' && !Array.isArray(entry[1])
    )
  );
}

function excludedOf(settings: Record<string, unknown> | null): string[] {
  const mcp = settings?.mcp;
  const excluded = mcp && typeof mcp === 'object' ? (mcp as Record<string, unknown>).excluded : undefined;
  return Array.isArray(excluded) ? excluded.filter((item): item is string => typeof item === 'string') : [];
}

// 读不懂的一份 = 那一层没有:qwen 自己也是这样(`loadProjectMcpServers` 解析失败只往 stderr 打一行 Warning,
// 那一层算空,照常开会话)。❌ 抛出 —— qwen 照常开会话,咕咕这边却会把这一家整个当成读不出来。
const tolerant = async (fs: PluginFs, path: string) => readJsoncObject(fs, path).catch(() => null);

export function qwenScopedMcpAdapter(): IMcpBehavior {
  const user = qwenMcpAdapter();
  return {
    ...user,
    async readScopedServers(fs, dirs) {
      const userSettings = await tolerant(fs, '.qwen/settings.json');
      const approvals = (await tolerant(fs, '.qwen/mcpApprovals.json')) ?? {};
      const scoped: McpScopedServers[] = [];
      for (const { dir, fs: dirFs } of dirs) {
        const workspaceSettings = await tolerant(dirFs, '.qwen/settings.json');
        const excluded = [...excludedOf(userSettings), ...excludedOf(workspaceSettings)];
        const root = process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir);
        const records = serversOf(approvals[root]);
        const layered: [string, Record<string, unknown>][] = [
          ...Object.entries(serversOf((await tolerant(dirFs, '.mcp.json'))?.mcpServers)).map(
            ([name, raw]): [string, Record<string, unknown>] => [name, normalizeClaudeMcpServer(raw)]
          ),
          ...Object.entries(serversOf(workspaceSettings?.mcpServers)),
        ];
        // 同名后者胜(工作区盖项目):Map 照插入覆盖。
        const byName = new Map(layered);
        const servers: McpServerRegistration[] = [...byName].map(([name, native]) => {
          // 方言照文件读法同一份(httpUrl → type:'http' + url,去掉注入的 Accept 头)。
          const reg = geminiFamilyNativeToRegistration(name, native);
          const record = records[name];
          const state = record && record.hash === hashMcpServerConfig(native) ? record.status : 'pending';
          const connects = state === 'approved' && !excluded.some((pattern) => matchesPattern(name, pattern));
          return connects ? reg : { ...reg, enabled: false };
        });
        if (servers.length > 0) scoped.push({ kind: 'project', dir, servers });
      }
      return scoped;
    },
  };
}
