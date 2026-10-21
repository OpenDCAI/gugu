import { recordRuntimeForkOwnership } from '../../sessions/runtime-fork-ownership';

type AcpStartPersistenceInput = {
  sessionId: string;
  providerSessionId: string | null;
  forkFromProviderSessionId?: string;
  sourceSessionId?: string;
  providerId?: string;
  workspaceId?: string;
  cwd?: string;
};

type AcpStartPersistenceResult =
  | { success: true; data: { providerSessionId: string } }
  | { success: false; error: { type: string } };

export async function persistAcpStartResult(
  input: AcpStartPersistenceInput,
  result: AcpStartPersistenceResult,
  deps: {
    persistReturnedProviderSessionId(sessionId: string, providerSessionId: string): Promise<void>;
    persistProviderSessionMissing(sessionId: string, providerSessionId: string): Promise<void>;
    recordRuntimeForkOwnership?: typeof recordRuntimeForkOwnership;
  }
): Promise<void> {
  // 运行时分叉(侧边聊天)由它那条 runtime-only tab 拥有:view id 与 provider 会话都不进
  // conversations 表,失败/缺会话那几条路也一样。
  //
  // ⚠️ 判据是 **`sourceConversationId`**,❌ 不是「带没带 `forkFromSessionId`」——
  // spec session-fork-share 的持久分叉(产品里的「Fork 会话」)同样带 `forkFromSessionId`,
  // 但它是一条要落库的正式会话:`session/fork` 产出的那个**独立** id 必须写进 `session_id`,
  // 否则重开这条分叉时找不回来(实测形态最阴:分叉当场能聊、界面一切正常,而 `session_id`
  // 一直是 null —— 要等用户下次打开它才现形)。
  const isRuntimeFork = Boolean(input.forkFromProviderSessionId) && Boolean(input.sourceSessionId);
  if (isRuntimeFork) {
    if (input.sourceSessionId && input.sourceSessionId !== input.sessionId) {
      if (result.success) {
        await (deps.recordRuntimeForkOwnership ?? recordRuntimeForkOwnership)({
          runtimeSessionId: input.sessionId,
          sourceSessionId: input.sourceSessionId,
          forkedFromSessionId: input.sourceSessionId,
          provider: input.providerId ?? 'unknown',
          providerSessionId: result.data.providerSessionId,
          workspaceId: input.workspaceId ?? '',
          cwd: input.cwd ?? '',
        });
      }
    }
    return;
  }

  if (result.success) {
    await deps.persistReturnedProviderSessionId(input.sessionId, result.data.providerSessionId);
  } else if (result.error.type === 'provider_session_missing' && input.providerSessionId !== null) {
    await deps.persistProviderSessionMissing(input.sessionId, input.providerSessionId);
  }
}
