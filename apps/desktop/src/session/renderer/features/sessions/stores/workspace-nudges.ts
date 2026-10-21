import type { AgentStatus } from '@gugu/core/shared/agentStatus';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { events } from '@renderer/lib/ipc';
import { sessionAgentStatusChangedChannel } from '@shared/core/sessions/sessionEvents';

/**
 * 「这个工作区下面可能变过」:见 Workspace.nudge。`reindex`:顺带让文件索引重扫(搜索被打开时)。
 * 返回索引是不是真的重扫了 —— 只在一个目录一个 watch 的平台上才会;别的平台索引本来就实时,什么都不多做。
 */
export function nudgeWorkspace(projectId: string, workspaceId: string, options?: { reindex?: boolean }): Promise<boolean> {
  return workspaceRpc(projectId)
    .files.nudgeWorkspace(projectId, workspaceId, options)
    .then(
      (result) => result.success && result.data.rescanned,
      () => false
    );
}

/**
 * 一个目录一个 watch 的平台上(Linux),git 改动、App 这些整棵树的订阅只看得到被盯着的目录;
 * 没人盯着的地方变了,靠这两个时刻补一次重算:窗口回到眼前,和这个项目里某个 agent 从 working 变成 idle
 * (它刚改完东西)。只订阅现成的状态事件,❌ 碰状态链路。项目里有几个工作区就各补一次 —— 事件里没有工作区,
 * 多算一次 git status 是便宜的。
 */
export function wireWorkspaceNudges(projectId: string, workspaceId: string): () => void {
  const nudge = () => void nudgeWorkspace(projectId, workspaceId);
  window.addEventListener('focus', nudge);
  const lastStatus = new Map<string, AgentStatus>();
  const off = events.on(sessionAgentStatusChangedChannel, (change) => {
    if (change.projectId !== projectId) return;
    const status = change.reading?.status;
    if (!status) return;
    const before = lastStatus.get(change.sessionId);
    lastStatus.set(change.sessionId, status);
    if (before === 'working' && status === 'idle') nudge();
  });
  return () => {
    window.removeEventListener('focus', nudge);
    off();
  };
}
