import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // mimocode —— opencode 的品牌分支,**与 opencode 共用** openCodeFamilyConfigContent 那份文档,
  //   所以形状逐字相同、旋钮也相同。❌ 别给它单独推一个结论,也❌ 别让两家在这里分叉。
  wireProtocol: 'openai-responses',
  dialect: 'mimocode-config-content',
  injection: {
    cui: {
      // opencode 的品牌分支,凭据同样随 spawn 时的配置文档进去 —— 与 opencode 那一格同载体。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'spawnEnvConfigDocument' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
