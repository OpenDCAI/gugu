export { bootAgentConfigRuntimeProcess, type BootAgentConfigRuntimeProcessOptions } from './boot';

// ❌ 这里曾经还有一个 `createNodeAgentConfigRuntime`:全仓 0 调用,而它建出来的
// `AgentPluginHost` **没有账**(#6101)—— 第二种构造方式就是第二套读数的入口。
// 无头 runtime 只有 `bootAgentConfigRuntimeProcess` 这一条,账由属主推进来。
