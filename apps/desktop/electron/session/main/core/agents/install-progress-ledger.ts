import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';

/**
 * #6264 每家 agent 此刻在这台机器上装到哪了 —— 给「别的机器上建会话、那边当场装」时,
 * 发起方(另一台桌面)隔一秒来问一次(设备 RPC `taskpage.agent.installProgress`)。
 *
 * 读数就是本机安装面板那一路进度事件的同一份(agentsController.install 的 onProgress),
 * ❌ 不另测一遍。装完(成败都算)就清掉:过期的读数被当成「还在装」比没有更糟。
 */
const installing = new Set<string>();
const latest = new Map<string, AgentInstallProgress>();

export function markInstallStarted(providerId: string): void {
  installing.add(providerId);
  latest.delete(providerId);
}

export function recordInstallProgress(progress: AgentInstallProgress): void {
  if (installing.has(progress.providerId)) latest.set(progress.providerId, progress);
}

export function markInstallEnded(providerId: string): void {
  installing.delete(providerId);
  latest.delete(providerId);
}
