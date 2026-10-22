// @@@task-shell-port (#5012) — 会话页渲染层取壳口的唯一入口(宿主口是 lib/ipc 的 `rpc`)。
// 桌面版:桥 = preload 的 electronAPI,壳口经 ipcMain 到 electron/main.ts;
// 网页版:桥 = 壳装的 WebSocket 客户端,壳在装桥时已把壳通道分流给自己(answerSessionShellChannels)。
//
// #6264 一套工作台:会话在别的机器上时,「这条会话绑的是哪个 agent / 它的地址 / 改它的名」问**那台机器**
// (绑定记在那台机器上,由它的主进程应答,见 device-session-host.ts 的兜底);分享名片、报障仍是这台电脑的界面。
// 侧栏那张「会话 → agent 名」表、@ 与拖拽用的会话名册,这一口只答本机那一份;别的机器上的会话读会话目录
// (行上带 agent id,名字从身份缓存按 id 取),❌ 每次逐台去问 —— 掉线又回来的那台会让弹层卡到超时(#7016)。
import {
  createSessionShellPort,
  type SessionShellAgentName,
  type SessionShellInvoke,
  type SessionShellPort,
} from '@shared/lib/ipc/shell-port'
import {
  sessionpageAgentProvisionedEvent,
  sessionpageAgentRenamedEvent,
} from '@shared/lib/ipc/sessionpage-identity-contract'
import { electronApi, findSessionHostBridge, type SessionHostBridge } from './electron-api'
import { invokeOnMachine, onMachineEvent } from './ipc'
import { onEachMachine } from './machine-clients'
import { machineRegistry } from './machine-routing'

let cached: { bridge: SessionHostBridge; port: SessionShellPort } | null = null

function machinePort(machine: string): SessionShellPort {
  return createSessionShellPort(((channel, ...args) => invokeOnMachine(machine, channel, ...args)) as SessionShellInvoke)
}

/**
 * 开户 / 改名两条事件(载荷同形,见 sessionpage-identity-contract):本机一份,每台连着的机器各订一份 —— 别的机器上的会话
 * 开户、改名,由那台机器推过来。❌ 只听本机的桥 —— 那样远端会话的身份卡永远等不到它。返回退订。
 */
export function onSessionpageIdentityEvent(cb: (event: SessionShellAgentName) => void): () => void {
  const listen = (machine: string | null) => {
    const offProvisioned = onMachineEvent(machine, sessionpageAgentProvisionedEvent, cb)
    const offRenamed = onMachineEvent(machine, sessionpageAgentRenamedEvent, cb)
    return () => {
      offProvisioned()
      offRenamed()
    }
  }
  const offLocal = listen(null)
  const offMachines = onEachMachine(listen)
  return () => {
    offLocal()
    offMachines()
  }
}

/** 按会话所在机器分流的壳口(本机那一份由 `local` 给)。 */
export function machineAwareShellPort(local: SessionShellPort): SessionShellPort {
  const machineOf = (sessionId: string | undefined) =>
    sessionId ? machineRegistry.machineOf(sessionId) : null
  return {
    agentCard: (sessionId) => {
      const machine = machineOf(sessionId)
      return machine ? machinePort(machine).agentCard(sessionId) : local.agentCard(sessionId)
    },
    agentNames: () => local.agentNames(),
    renameAgent: (input) => {
      const machine = machineOf(input.sessionId)
      return machine ? machinePort(machine).renameAgent(input) : local.renameAgent(input)
    },
    // 分享名片画在这台电脑上;名片(会话 → agent)取自会话所在的那台机器。
    shareAgent: async (sessionId) => {
      const machine = machineOf(sessionId)
      if (!machine) return local.shareAgent(sessionId)
      const card = await machinePort(machine).agentCard(sessionId)
      return local.shareAgent(sessionId, card)
    },
    openFeedback: () => local.openFeedback(),
    ensureAgentAddress: (input) => {
      const machine = machineOf(input.sessionId)
      return machine ? machinePort(machine).ensureAgentAddress(input) : local.ensureAgentAddress(input)
    },
    fatalBoot: (message) => local.fatalBoot(message),
    sessionPeers: () => local.sessionPeers(),
  }
}

function portOver(bridge: SessionHostBridge): SessionShellPort {
  if (cached?.bridge !== bridge) {
    cached = {
      bridge,
      port: machineAwareShellPort(createSessionShellPort((channel, ...args) => bridge.invoke(channel, ...args))),
    }
  }
  return cached.port
}

/** 没接线就响亮失败(与 electronApi 同一口径)—— 给「必须有壳才能继续」的路径(首轮寻址)。 */
export function shellPort(): SessionShellPort {
  return portOver(electronApi())
}

/** 没接线回 null —— 给「没有壳就按无身份呈现」的路径(分享入口),❌ 一个装饰性按钮把整页拖垮。 */
export function findSessionShellPort(): SessionShellPort | null {
  const bridge = findSessionHostBridge()
  return bridge ? portOver(bridge) : null
}

export { isSessionShellUnsupported } from '@shared/lib/ipc/shell-port'
