import { agentConfigRuntimeContract } from '@gugu/session-core/workspace-server';
import { createController } from '@gugu/session-wire';
import type { AgentConfigRuntime } from '../runtime/runtime';
import { createAgentConfigProcedures } from './procedures';

/**
 * agent-config runtime 只挂在私有合同上(#5683):登录 / 登录状态 / 凭据判断的 CLI 由宿主随请求给。
 * ❌ 别把 renderer 合同直接接到 runtime 上 —— 没有宿主就答不出用户选的是哪一份。
 */
export function createAgentConfigController(runtime: AgentConfigRuntime) {
  const procedures = createAgentConfigProcedures(runtime);
  return createController(agentConfigRuntimeContract, {
    ...procedures,
    installAgent: {
      run: (input, ctx) => runtime.installAgent(input.providerId, input.strategy, ctx),
      toError: (error) => ({
        type: 'command-failed' as const,
        message: error instanceof Error ? error.message : String(error),
        output: '',
      }),
    },
    agents: runtime.agentsLiveHost(),
    loginOutput: (key) => runtime.loginOutputLog(key.providerId, key.program, key.connectionId),
    mcpServers: runtime.mcpLiveHost(),
  });
}
