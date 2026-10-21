import { isProviderSessionMissingError } from '@gugu/session-core/acp';
import { HarnessStartupError, SessionRuntimeCompatibilityError } from '@gugu/session-core/agents/plugins';
import { guguCatalogReasonCode, guguReasonInText } from '@gugu/session-core/session-record/contract';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { isAppFocused } from '@main/core/agent-hooks/app-focus';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import type { RuntimeUpgradeRequirement } from '@shared/core/sessions/runtime-upgrade';

/**
 * 每条会话**最近一次**启动失败是不是「harness 版本低于下界」(#6341)。
 *
 * 唯一写者 = `emitSessionSpawnFailure`:每次启动失败都重写这一格(是 ⇒ 记下,不是 ⇒ 删掉),
 * 所以它回答的永远是「刚才那次失败」。读者是 renderer —— hydrate 被拒时按会话 id 来取
 * (`sessions.getRuntimeUpgradeRequirement`)。写在 throw 之前、同一条调用链上(local-session
 * 的 `emitSessionSpawnFailure(…); throw startupError`),所以 renderer 收到拒绝时它已经落定,❌ 不靠时序。
 */
const runtimeUpgradeRequirements = new Map<string, RuntimeUpgradeRequirement>();

export function getRuntimeUpgradeRequirement(sessionId: string): RuntimeUpgradeRequirement | null {
  return runtimeUpgradeRequirements.get(sessionId) ?? null;
}

/** 沿 `cause` / `AggregateError.errors` 找「版本低于下界」那一个;启动失败被包过几层(describeCodexStartFailure)。 */
export function findRuntimeVersionUnsupported(error: unknown): SessionRuntimeCompatibilityError | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof SessionRuntimeCompatibilityError) {
      if (current.code === 'runtime-version-unsupported') return current;
      continue;
    }
    queue.push((current as { cause?: unknown }).cause);
    if (current instanceof AggregateError) queue.push(...current.errors);
  }
  return null;
}

/**
 * 起任务失败交给界面之前按层分(#7103 谁拒绝谁说话):已经带原因码的(平台那一层)、harness 自己说的
 * (`HarnessStartupError`、版本 / 运行时不兼容)递那一句;其余都是咕咕这一侧的故障 —— 会话页宿主、推理进程的传输、
 * 本机库 —— 只交「咕咕这边出错了」的码,原文挂在 cause 上,进日志。沿 `cause` / `AggregateError.errors` 找,
 * 收尾失败包过一层的照样认得出。
 * 交出去的一律是普通 Error:Electron 按 `error.toString()` 把错交回渲染层,别的类名会跟着上屏。
 */
export function startupFailureForUser(error: unknown): unknown {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const spoken = current instanceof HarnessStartupError
      || current instanceof SessionRuntimeCompatibilityError
      || (current instanceof Error && guguReasonInText(current.message) !== null);
    if (spoken) return new Error((current as Error).message, { cause: error });
    queue.push((current as { cause?: unknown }).cause);
    if (current instanceof AggregateError) queue.push(...current.errors);
  }
  log.error('SessionSpawn: 咕咕这一侧的启动故障,界面只说「咕咕这边出错了」', {
    error: error instanceof Error ? error.message : String(error),
  });
  return new Error(guguCatalogReasonCode('service-unavailable'), { cause: error });
}

function toRuntimeUpgradeRequirement(error: SessionRuntimeCompatibilityError): RuntimeUpgradeRequirement | null {
  // 只认「读到了版本、而且有明确下界」的那一种 —— 没有这两个数,界面说不出「要升到几」。
  if (!error.installedVersion || !error.supportedFloor) return null;
  return {
    providerId: error.providerId,
    installedVersion: error.installedVersion,
    supportedFloor: error.supportedFloor,
    executable: error.probe?.executable ?? null,
  };
}

/**
 * A provider CLI that cannot spawn (binary missing from PATH, expired login,
 * broken shell profile) must surface as an error status — never a silently
 * empty conversation. Emitting an 'error' agent event routes the failure
 * through the same status pipeline as hook-reported errors: status machine →
 * sidebar "needs you" group + notification.
 */
export function emitSessionSpawnFailure(session: Session, error: unknown): void {
  const versionBlock = findRuntimeVersionUnsupported(error);
  const requirement = versionBlock ? toRuntimeUpgradeRequirement(versionBlock) : null;
  if (requirement) runtimeUpgradeRequirements.set(session.id, requirement);
  else runtimeUpgradeRequirements.delete(session.id);

  // 只有「刚拿着一条既有会话去 resume」时，-32002 才等于「引擎那边没这条会话了」——那条路自己有界面
  // （照首轮重来），不必再报一次 agent 错。新建 / 首次 spawn 手上没有 session id，任何失败都要照常
  // 上报：❌ 让一个不相干的 -32002 把真失败悄悄吞掉，那样会话既没起来、状态栏也不说话。
  // ⚠️ 「有 sessionId」判不出「正在恢复」：PTY 会话出生那一刻 session_id 就被写成**自己的会话 id**
  // （build-conversation-row.sessionIdAtBirth 的 `claimsFirstSpawn ? input.id : null`），而这两个
  // 调用点(local / ssh)全是 PTY。真正的 provider session id 一定不等于会话自己的 id。
  const resumingProviderSessionId =
    session.providerSessionId && session.providerSessionId !== session.id ? session.providerSessionId : '';
  if (
    resumingProviderSessionId
    && isProviderSessionMissingError(error, { resumingProviderSessionId })
  ) return;

  const message = error instanceof Error ? error.message : String(error);
  log.error('SessionSpawn: agent session spawn failed', {
    sessionId: session.id,
    providerId: session.providerId,
    error: message,
  });
  agentHookService.emitAgentEvent(
    {
      type: 'error',
      providerId: session.providerId,
      projectId: session.projectId,
      sessionId: session.id,
      timestamp: Date.now(),
      payload: { message },
    },
    isAppFocused()
  );
}
