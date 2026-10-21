import { createContext } from 'react'

/**
 * 还在跑的那一轮里**最后一条**消息的 id(没在跑 = null)。
 * 这条线程的 isRunning 只算「这台手机正在发」(AgentThread 的 #3566),官方动作栏的 hideWhenRunning 看不见远端在跑 ⇒
 * 一句话写到一半,下面就已经挂着「复制 / ⋯」。远端在跑由时间线判(AgentThread 的 agentWorking),
 * 这里只把那一条的动作栏换成一颗「正在回」的点 —— 同官方 indicator 那一颗(thread.aui @@@live-accent)。
 */
export const LiveTail = createContext<string | null>(null)
