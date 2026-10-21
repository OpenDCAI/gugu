// #5415 —— 「寻址不是交接」的判据。
//
// 聊天页 `ensureAgentAddress` 经 provisionLocked 重入开户,而开户会跑一遍 owner 交接编排。
// 交接是「旧属主 → 新属主」的动作:它先装离线 blocker,再释放 live 认领者。跑在**自己**身上,
// 就是把这条会话自己那条正在等首轮投递的原生会话处置掉(owner 实例日志的调用栈:
// CodexAppServerRegistry.unregister ← unregisterNonLocal… ← prepareSessionpageDeliveryOwner
// ← provisionLockedBody ← provisionLocked ← ensureAgentAddress),于是首轮永远等不到,
// 报 `codex app-server 会话 … closed before first injected turn`。
//
// 判据两个方向都要能判:**同一条 conversation 的活属主必须活下来**,而
// **别的 conversation 的旧认领者必须照样被处置** —— 只判前者的话,一个「什么都不清」的错修法也能全绿。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registerEmdashAgent: vi.fn(),
  unregisterEmdashAgent: vi.fn(),
  unregisterNative: vi.fn(async (_guguAgentUserId: string, replaceAfterRelease?: () => void) => {
    replaceAfterRelease?.()
  }),
}))

vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-registry', () => {
  const emdashAgentRegistry = {
    deliveryTargetName: 'gugu-acp',
    // 兼容 owner 也可能记着同一条 conversation —— 它是占位,交接要交的就是它,不受保护。
    liveSessionIdByAgent: (guguAgentUserId: string) =>
      emdashHolds.sessionId && emdashHolds.agentUserId === guguAgentUserId
        ? emdashHolds.sessionId
        : null,
    releaseAgentClaim: (guguAgentUserId: string) => mocks.unregisterEmdashAgent(guguAgentUserId),
    unregisterAgent: (guguAgentUserId: string, onReleased?: () => void) => {
      mocks.unregisterEmdashAgent(guguAgentUserId)
      onReleased?.()
    },
  }
  return {
    emdashAgentRegistry,
    registerEmdashAgent: mocks.registerEmdashAgent,
    unregisterEmdashAgent: mocks.unregisterEmdashAgent,
  }
})

import {
  prepareSessionpageDeliveryOwner,
  registerSessionpageDeliveryTarget,
  releaseSessionpageDeliveryClaimsExcept,
  nativeOwnerHoldsSessionpageDeliveryClaim,
  unregisterSessionpageDeliveryOwners,
} from '../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry'
import {
  localSessionDeliveryTarget,
  unregisterLocalSessionDelivery,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import type { SessionpageDeliveryTarget } from '../../../../apps/desktop/electron/sessionpage/session-injection'

const emdashHolds = { agentUserId: null as string | null, sessionId: null as string | null }
// 原生 app-server 类认领者。`liveSessionIdByAgent` 报的是**产品 conversation**(@@@4629 订下的口径),
// 这条 claim 的另一半就在这里 —— 假替身必须照那个口径实现,否则判据判的是另一件事。
const nativeHolds = { agentUserId: null as string | null, sessionId: null as string | null }
const fakeNative: SessionpageDeliveryTarget = {
  deliveryTargetName: 'fake-app-server-5415',
  liveSessionIdByAgent: (guguAgentUserId) =>
    nativeHolds.agentUserId === guguAgentUserId ? nativeHolds.sessionId : null,
  sessionProviderSurface: () => null,
  tryInjectSessionMessage: async () => false,
  unregisterAgent: (guguAgentUserId, onReleased) =>
    onReleased
      ? mocks.unregisterNative(guguAgentUserId, onReleased)
      : mocks.unregisterNative(guguAgentUserId),
}
registerSessionpageDeliveryTarget(fakeNative)

const AGENT = 'agent-5415'
const SESSION = 'conversation-5415'
const claim = { guguAgentUserId: AGENT, sessionId: SESSION }

describe('#5415 一次只为取地址的开户重入,不得处置这条会话自己的 live 属主', () => {
  beforeEach(() => {
    nativeHolds.agentUserId = null
    nativeHolds.sessionId = null
    emdashHolds.agentUserId = null
    emdashHolds.sessionId = null
    vi.clearAllMocks()
    unregisterLocalSessionDelivery(SESSION)
  })

  it('这条 claim 的原生属主已 live ⇒ 交接整趟不发生(不处置、不装离线 blocker)', async () => {
    nativeHolds.agentUserId = AGENT
    nativeHolds.sessionId = SESSION
    expect(nativeOwnerHoldsSessionpageDeliveryClaim(claim)).toBe(true)

    await prepareSessionpageDeliveryOwner('native', claim, { providerId: 'codex' })

    expect(mocks.unregisterNative, '正在等首轮的 app-server 会话被处置了 —— 这就是 #5415').not.toHaveBeenCalled()
    expect(mocks.registerEmdashAgent).not.toHaveBeenCalled()
    expect(
      localSessionDeliveryTarget.liveSessionIdByAgent(AGENT),
      '原生属主还活着的时候装离线 blocker = 两个属主,router 基数检查会当结构歧义拒掉',
    ).toBeNull()
  })

  // ★阴性对照:换掉的只有「属主认领的是哪条 conversation」,判据与装置一字不动。
  //  它必须红 —— 否则一个「什么都不清」的错修法也能让上面那条绿。
  it('原生认领者认领的是另一条 conversation ⇒ 照样被交接处置', async () => {
    nativeHolds.agentUserId = AGENT
    nativeHolds.sessionId = 'conversation-other'
    expect(nativeOwnerHoldsSessionpageDeliveryClaim(claim)).toBe(false)

    await prepareSessionpageDeliveryOwner('native', claim, { providerId: 'codex' })

    expect(mocks.unregisterNative, '别的 conversation 的旧认领者必须被清掉').toHaveBeenCalledWith(AGENT)
    expect(localSessionDeliveryTarget.liveSessionIdByAgent(AGENT)).toBe(SESSION)
    unregisterLocalSessionDelivery(SESSION)
  })

  // ★第三个方向的控:`emdash` 是**真的换属主种类**(编程腿 → 通用腿)。
  //  `switchSessionRuntime` 的 dehydrate 只 detach、按契约不处置 app-server,所以到这里时
  //  原生属主还活着 —— 它必须被降级。守卫要是把这一支也短路掉,一条已经切成通用腿的会话
  //  会继续挂在 codex app-server 上,而这条判据就是那个错法的红灯。
  it('换属主种类(emdash)时,同一条 conversation 的 live 原生属主照旧被降级', async () => {
    nativeHolds.agentUserId = AGENT
    nativeHolds.sessionId = SESSION

    await prepareSessionpageDeliveryOwner('emdash', claim, { providerId: 'codex' })

    expect(mocks.unregisterNative, 'TUI → ACP 切换必须把原生属主降级').toHaveBeenCalledWith(AGENT, expect.any(Function))
    expect(mocks.registerEmdashAgent, '兼容 owner 必须装上').toHaveBeenCalled()
  })

  it('清场按 claim 收窄:保住这条 claim 的原生属主,兼容 owner 即使记着同一条也照清', async () => {
    nativeHolds.agentUserId = AGENT
    nativeHolds.sessionId = SESSION
    emdashHolds.agentUserId = AGENT
    emdashHolds.sessionId = SESSION

    await releaseSessionpageDeliveryClaimsExcept(claim)

    expect(mocks.unregisterNative).not.toHaveBeenCalled()
    expect(mocks.unregisterEmdashAgent).toHaveBeenCalledWith(AGENT)
  })

  it('删身份那条破坏性边界不按 claim 收窄:live 原生属主一并摘掉', async () => {
    nativeHolds.agentUserId = AGENT
    nativeHolds.sessionId = SESSION

    await unregisterSessionpageDeliveryOwners(AGENT)

    expect(mocks.unregisterNative).toHaveBeenCalledWith(AGENT)
    expect(mocks.unregisterEmdashAgent).toHaveBeenCalledWith(AGENT)
  })
})
