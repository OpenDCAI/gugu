import {
  AGENT_WAIT_KINDS,
  type AgentStatus,
  type AgentStatusDetail,
} from '@gugu/core/shared/agentStatus';

/**
 * 一组会话汇成一格(任务行、标签、命令面板)时的附属态,与 `sessionStatus` 选出的那个基础态配对:
 * working 有一条在跑就是 `running`,全部只剩后台才 `parked`(附属态缺席算在跑);
 * needs_user 取优先级最高的等待种类(与宿主 reduce 同序:AGENT_WAIT_KINDS),一条都说不出就 `null`。
 * 画成什么由 `presentAgentStatus` 决定,这里只负责「这一格的读数是哪一个」。
 */
export function aggregateStatusDetail(
  status: AgentStatus | null,
  members: Iterable<{ status: AgentStatus | null; detail: AgentStatusDetail | null }>
): AgentStatusDetail | null {
  if (status === 'working') {
    let anyWorking = false;
    for (const member of members) {
      if (member.status !== 'working') continue;
      if (member.detail !== 'parked') return 'running';
      anyWorking = true;
    }
    return anyWorking ? 'parked' : null;
  }
  if (status === 'needs_user') {
    const kinds = new Set<AgentStatusDetail>();
    for (const member of members) {
      if (member.status === 'needs_user' && member.detail) kinds.add(member.detail);
    }
    return AGENT_WAIT_KINDS.find((kind) => kinds.has(kind)) ?? null;
  }
  return null;
}
