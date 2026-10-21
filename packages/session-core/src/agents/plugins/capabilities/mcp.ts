import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { PluginFs } from '../../runtime/fs';

export type McpTransport = 'stdio' | 'http';

export type IMcpBehavior = {
  readServers(fs: PluginFs): Promise<McpServerRegistration[]>;
  writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void>;
  removeServer(fs: PluginFs, name: string): Promise<void>;
  /**
   * 按目录生效的那几层 —— 只有配置分作用域的家实现(Claude:本地级 `~/.claude.json` 的
   * `projects[<目录>].mcpServers`、项目级 `<目录>/.mcp.json`)。`readServers` 只给全局那一层;
   * 少了这一格,开会话、`/mcp` 面板都看不见这两层,而那一家的会话照样装载它们(10-07 资源库体检实测)。
   * `dirs` 由宿主给:目录取真实路径(那一家按真实路径记),`fs` 以那个目录为根。
   */
  readScopedServers?(fs: PluginFs, dirs: readonly McpScopeDir[]): Promise<McpScopedServers[]>;
};

export type McpScopeDir = { dir: string; fs: PluginFs };

export type McpScopedServers = {
  kind: 'local' | 'project';
  dir: string;
  servers: McpServerRegistration[];
};

export type McpServerRegistration = {
  name: string;
  transport?: McpTransport;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
  oauth?: Record<string, unknown> | false;
  [key: string]: unknown;
};

/**
 * 咕咕 MCP 工具在这一家**模型眼里**叫什么、经哪条路调用 —— harness 的能力事实,由 adapter 声明。
 *
 * 平台块只说 canonical 名(`message_send`);每条会话的自述块从这里渲染**这一家**的形态
 * (`capability-bundle.ts` 的 `guguToolNamingLine`),投递记账的工具名也从这里派生。
 * ❌ 别再在 prompt 或工具描述里写一张按家枚举的清单:那张清单漏了哪家,哪家的模型就按裸名去找。
 *
 * - `listed`:每个工具以 `<prefix><tool>` 直接出现在模型的工具表里,直接调用。
 * - `proxied`:工具不逐个上表,模型经 `proxyTool` 这一个代理工具按名调用(名字仍是 `<prefix><tool>`)。
 * - `server-proxied`:工具不逐个上表,模型经 `proxyTool` 这一个通用工具调,而**目标由两个参数分开给出** ——
 *   `serverArg` 填 server 名(咕咕那台就是 `gugu`)、`toolArg` 填**裸**工具名(`message_send`)。
 *   与 `proxied` 的区别是**没有前缀拼成的全名**:模型眼里根本不存在 `<prefix><tool>` 这个字符串,
 *   ❌ 别为了套进 `proxied` 硬造一个前缀 —— 那是在自述块里教模型一个它的 harness 不认的名字。
 *   首个声明者 Antigravity 终端腿(agy CLI 的 `call_mcp_tool {ServerName, ToolName, Arguments}`)。
 * - `namespaced`:工具进模型的工具表时收在一个**命名空间**里,名字是**裸**的(Responses API 的 namespace 工具:
 *   模型发 `{namespace: "mcp__gugu", name: "message_send"}`)。模型眼里不存在 `mcp__gugu__message_send` 这个
 *   字符串 ⇒ ❌ 套进 `listed` 硬写前缀(#6615 问题 11:Codex 0.156.1 聊天面板腿实测,自述块原先教的就是这个
 *   不存在的名字)。投递面按裸名说。
 * - `unmeasured`:咕咕没量过这家的形态 —— 自述块不写这一行,模型只拿到通用规则。
 *   ⚠️ 这是一句说出口的欠账,❌ 不是默认值;量到了就改成上面几种之一并写 evidence。
 * - `per-surface`:同一家两条腿的形态**不一样**时按腿分别声明(与 `units.*` 的 `per-surface` 同一个意思)。
 *   Antigravity 是例子:聊天面板腿跑 `agy_acp_server`、终端腿跑 `agy`,两个程序,MCP 工具进模型的方式不同。
 *   缺席的那条腿按 `unmeasured` 读 —— ❌ 不从另一条腿借答案。
 *
 * 「延迟装载」不是这里的第三种形态:会话包对咕咕那台 server 声明了 `alwaysLoad`,把它送到
 * harness 的原生开关是物化器的职责(送不到就报 degraded)。
 */
const surfaceToolNamesSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('listed'),
    prefix: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.object({
    kind: z.literal('proxied'),
    prefix: z.string().min(1),
    proxyTool: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.object({
    kind: z.literal('server-proxied'),
    proxyTool: z.string().min(1),
    serverArg: z.string().min(1),
    toolArg: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.object({
    kind: z.literal('namespaced'),
    namespace: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.object({ kind: z.literal('unmeasured') }),
]);

const toolNamesSchema = z.union([
  surfaceToolNamesSchema,
  z.object({
    kind: z.literal('per-surface'),
    surfaces: z.object({
      'acp': surfaceToolNamesSchema.optional(),
      'tui': surfaceToolNamesSchema.optional(),
    }),
  }),
]);

/** 一条腿上的形态(已经摊开 `per-surface`)。 */
export type McpSurfaceToolNames = z.infer<typeof surfaceToolNamesSchema>;
export type McpToolNames = z.infer<typeof toolNamesSchema>;

/**
 * 这条腿上咕咕工具在模型眼里的形态 —— 读 `toolNames` 的**唯一**入口,别处 ❌ 自己拆 `per-surface`。
 * 按腿声明而这条腿没写 ⇒ `unmeasured`(欠账照实说,❌ 借另一条腿的答案)。
 */
export function mcpToolNamesOn(
  toolNames: McpToolNames,
  surface: 'acp' | 'tui'
): McpSurfaceToolNames {
  if (toolNames.kind !== 'per-surface') return toolNames;
  return toolNames.surfaces[surface] ?? { kind: 'unmeasured' };
}

export const mcpCapability = definePluginCapability<IMcpBehavior>()(
  'mcp',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('supported'),
      scope: z.enum(['global']),
      supportedTransports: z.array(z.enum(['stdio', 'http'])),
      /**
       * 会话级要不要把**用户自己的 MCP Server** 复述一遍。
       *
       * - `'inherit'`:这一家在会话里仍读用户自己的 MCP 配置(咕咕的会话级声明与它**合并**)
       *   ⇒ 会话包只带咕咕自己那几台,用户那几台一台都不进来。
       * - `'restate'`:咕咕必须把用户仍启用的每一台**完整**递回去 —— 只有被指示忽略文件来源的
       *   那一家需要(claude 的 `--strict-mcp-config`)。
       *
       * 缺省是 `'restate'`(= 2026-09-07 之前所有家的行为)。❌ 不要为了"看起来更干净"批量改成
       * `'inherit'`:判据是**那一家的会话通道到底与用户配置合并还是替换**,每家要有实测。
       *
       * 为什么这是一格**声明**而不是在调用点分叉:复述一份不属于咕咕的配置有两笔实打实的代价,
       * 而它们只在"其实不需要复述"的那些家身上是纯亏损 ——
       *  · 复述是**有损**的:codex 的 `-c mcp_servers.<名>.…` 是整条替换,咕咕只写得出
       *    command/args/env,用户自己写的 `cwd` / `env_vars` / `startup_timeout_sec` 随之丢失;
       *  · 复述要求咕咕**校验**别人的配置,而咕咕的判据比文件主人严 —— 一个合法的空字符串
       *    (ChatGPT.app 写进 `~/.codex/config.toml` 的 `NODE_REPL_...= ""`)就让整条会话开不起来。
       */
      sessionUserServers: z.enum(['inherit', 'restate']).optional(),
      /** 必答,见 `toolNamesSchema` 抬头。 */
      toolNames: toolNamesSchema,
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  { kind: 'none' }
);
