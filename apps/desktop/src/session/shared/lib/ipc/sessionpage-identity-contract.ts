// @@@task-shell-port (#5012) — 网页版宿主的「会话身份」rpc 契约:浏览器壳与无头宿主共用这一份类型。
//
// 桌面版里给会话开咕咕账号(provisioning)跑在壳主进程,它同时握着登录态与本机 roster。网页版把两者
// 拆开:登录态在浏览器,roster 在宿主机。于是浏览器按次把登录态交给宿主(宿主是用户自己的机器,与
// 桌面主进程同一信任级别),宿主用它开账号、绑会话、开私聊;壳口的 agentCard / ensureAgentAddress
// 由壳转交宿主完成 —— 壳仍是应答方,只是把机器侧的活委托出去。
import type {
  SessionShellAgentAddress,
  SessionShellAgentAddressInput,
  SessionShellAgentCard,
  SessionShellAgentName,
  SessionShellPeer,
} from './shell-port'
import { defineEvent } from './events'

/** 浏览器交给宿主的登录态。宿主**不自行刷新**:refresh token 轮换会让两边其中一方失效,续期由浏览器推送。 */
export interface SessionpageIdentityAuth {
  accessToken: string
  refreshToken: string
  userId: string
}

/** 宿主侧 rpc 命名空间 `sessionpageIdentity.*` 的方法表;浏览器经 createRPCClient 调用。 */
export type SessionpageIdentityRpc = {
  /** 登录态推送:连上时一次、每次续期一次、宿主重连后再一次。null = 已登出,宿主随即拒绝开账号。 */
  setAuth(auth: SessionpageIdentityAuth | null): Promise<void>
  agentCard(sessionId: string): Promise<SessionShellAgentCard | null>
  /** 侧栏身份卡要的那张表:本机花名册上全部「会话 → 显示名 + agent id」(#5818 / #6092)。 */
  agentNames(): Promise<SessionShellAgentName[]>
  sessionPeers(sessionId?: string): Promise<SessionShellPeer[]>
  ensureAgentAddress(input: SessionShellAgentAddressInput): Promise<SessionShellAgentAddress>
}

export type SessionpageIdentityRouter = { sessionpageIdentity: SessionpageIdentityRpc }

/**
 * 宿主 → 会话页:某条会话刚拿到咕咕身份。桌面主进程、无头宿主、经设备连接看着这台机器的别的电脑,
 * 收发都是这一个定义 —— 载荷形状由类型钉住,任一端改字段名当场编译不过(#6936 曾因原样转发静默断掉)。
 */
export const sessionpageAgentProvisionedEvent = defineEvent<SessionShellAgentName>('sessionpage-agent-provisioned')
