import type { DeviceCommand, DeviceStatus } from '../types/chat'

// @@@5912 设备租约的 TTL。**这个数只由库求值** —— 清扫者拿它把「租约过期」变成一次
// online → offline 的边沿(gugu-supabase 的 supabase/migrations/20260920100000_device_online_is_an_explicit_fact_5912.sql),
// 命令插入的 RLS 与 build_agent_presence_payload 拿它做读时闸。数值与那几处 SQL 的 `interval '2 minutes'` 同源。
// 客户端这一侧只剩一个用途:deviceDaysOffline 判「刚过窗口还不算一天」。❌ 别再拿它推在线。
export const DEVICE_ONLINE_STALE_MS = 2 * 60 * 1000

// @@@1594 — agent.create 设备命令的「容许重试」held 窗口。本机单 device 串行处理命令,并发创建多个 agent 时
// 靠后的 create 排队;runtime 在此窗口内把未就绪的 create requeue 重试(created_at 不变),超窗才落终态(防真失败
// agent 无限重试)。
// @@@agent-startup-timeouts(product spec §1,2026-07-13 实测)90s → 150s:90s 对 MCP 加载/
// ACP 握手类瞬时未就绪(isTransientAgentNotReadyError)余量不足;150s 加足余量,同时不让真失败的 agent 无限吞
// 消息重试。边界(明确接受):不覆盖分钟级的运行时下载——超窗消息仍终态失败。
export const AGENT_INIT_HELD_TIMEOUT_MS = 150_000

// @@@5912 在线是库拥有的一个显式状态,看的人只读结论。
//
// 改前这里是 `status === 'online' && last_seen_at 在 2 分钟内` —— 一个**每个客户端各算一遍**的判据,
// 而它两边来自两个钟(写者盖的时间戳 vs 读者的 now)。它要成立,库就得把每一次心跳都广播给每一个
// 在线客户端好让那个时间戳保持新鲜 ⇒ 空闲流量 O(客户端数 × 时间)。现在超时只由清扫者数一遍,
// 客户端拿到的是边沿。⇒ 这个函数只剩一行,那正是这次改动的全部内容。
export function isDeviceOnline(status: DeviceStatus): boolean {
  return status === 'online'
}

export function isDeviceCommandDone(command: DeviceCommand): boolean {
  return command.status === 'done'
}

export function isDeviceCommandError(command: DeviceCommand): boolean {
  return command.status === 'error'
}
