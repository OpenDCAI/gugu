import type { InitialQueuePrompt } from '@shared/core/sessions/sessions';

export type LaunchOutcome =
  | { ok: true }
  | { ok: false; code: 'provision_failed' | 'session_start_failed'; detail: string };

/**
 * 挂上工作区、起 agent。会话行已经由 `prepareCreateSession → commitCreateSession` 写下之后,**所有**不经会话页
 * 打开的创建都走这一份:别的机器 / 手机建会话、「再试一次」、导入、以及「已安排」到点开的会话 ——
 * 几条路起进程的入参必须一致。
 *
 * 起进程:桌面上这一步由打开会话页触发(hydrate / wake);没人会去打开会话页的发起方(别的机器、调度器)
 * 就在这里直接走**同一个**启动入参构造(`acpStartInputFor`,唤醒与重载共用的那份)—— ❌ 不手写启动入参,
 * 手写一份漏掉权限档/推理档就等于刚选的那两维白选(「已安排」原来那条路就是这么漏的)。
 * 聊天腿把第一句放进启动队列,起来之后照常投递。
 *
 * ⚠️ 重依赖一律**用时再取**:这个模块挂在设备 RPC 上(见 create-session.ts 的 agentPayloads 抬头)。
 */
export async function launchCreatedSession(input: {
  sessionId: string;
  projectId: string;
  runtime: 'acp' | 'pty';
  initialQueue: InitialQueuePrompt[] | undefined;
  launchWorkspace: () => Promise<
    { success: true; data: { workspaceId: string; path: string } } | { success: false; error: unknown }
  >;
}): Promise<LaunchOutcome> {
  let provision;
  try {
    provision = await input.launchWorkspace();
  } catch (error) {
    return { ok: false, code: 'provision_failed', detail: (error as Error)?.message ?? String(error) };
  }
  if (!provision.success) return { ok: false, code: 'provision_failed', detail: JSON.stringify(provision.error) };

  if (input.runtime === 'acp') {
    const [{ admitCreationTurns }, { getSessions }] = await Promise.all([
      import('@main/core/sessions/session-life-creation'),
      import('@main/core/sessions/getSessions'),
    ]);
    const session = (await getSessions()).find((candidate) => candidate.id === input.sessionId);
    if (!session) return { ok: false, code: 'session_start_failed', detail: '会话行落库后读不回来' };
    // session-life starts it: the creation turns are its first pending rows; startup progress and failure are
    // the session's own lifecycle facts from here on.
    try {
      admitCreationTurns({ ...session, initialQueue: input.initialQueue ?? session.initialQueue });
    } catch (error) {
      return { ok: false, code: 'session_start_failed', detail: (error as Error)?.message ?? String(error) };
    }
    return { ok: true };
  }
  const { hydrateSession } = await import('@main/core/sessions/hydrateSession');
  try {
    await hydrateSession(input.projectId, input.sessionId);
  } catch (error) {
    return { ok: false, code: 'session_start_failed', detail: (error as Error)?.message ?? String(error) };
  }
  return { ok: true };
}
