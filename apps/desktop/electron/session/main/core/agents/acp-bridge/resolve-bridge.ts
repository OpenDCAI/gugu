/**
 * `acp.bridge` 声明 → 桥入口的纯逻辑(#6394)。IO(electron、npm、插件表)在 `index.ts`,这里注入。
 */
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type { AcpBridgeSource } from '@gugu/session-core/agents/plugins';
import type { AgentProgramRole } from '@gugu/session-core/deps/runtime';
import type { BridgeWait } from './claude-bridge';

export type BridgeResolveDeps = {
  /** 随包的 npm 包里某个文件的入口(从应用根解析)。 */
  resolveBundled(specifier: string): string;
  /** 随应用构建的桥文件的入口(dist-electron/runtime/)。 */
  appRuntimeEntry(file: string): string;
  /** 按用户这份 Claude 的版本配对;`undefined` = 用随包那份。`wait` 见 `BridgeWait`(只有真会话启动传)。 */
  pairClaude(cliPath: string, env: Record<string, string>, wait?: BridgeWait): Promise<string | undefined>;
};

/**
 * 声明解析成入口。
 *
 * - 按 CLI 版本配对(下载)只给聊天腿(`acp`)做:`primary`(登录、登录状态)用随包那份就够,
 *   ❌ 不为它探版本、联网。CLI 解析失败时也用随包那份 —— 起不来的原因由会话边界照常报。
 * - 这里不吞错:随包的包找不到、app-runtime 文件路径算不出,都是打包/接线坏了,当场抛。
 */
export async function resolveAcpBridgeEntry(
  bridge: AcpBridgeSource,
  input: { role: AgentProgramRole; cli: AgentRunContext['cli']; env: Record<string, string>; wait?: BridgeWait },
  deps: BridgeResolveDeps,
): Promise<string> {
  if (bridge.kind === 'app-runtime') return deps.appRuntimeEntry(bridge.file);
  const bundled = () => deps.resolveBundled(`${bridge.alias}/${bridge.entry}`);
  if (bridge.pairWith === 'claude' && input.role === 'acp' && input.cli.kind === 'resolved') {
    return (await deps.pairClaude(input.cli.path, input.env, input.wait)) ?? bundled();
  }
  return bundled();
}
