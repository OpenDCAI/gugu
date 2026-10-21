import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { createController, type EventStreamHost } from '@gugu/session-wire';
import type { AcpRuntime } from '../runtime/runtime';
import { createAcpProcedures } from './procedures';

/**
 * ACP runtime 只挂在私有合同上。
 *
 * ❌ 别再加一个把 renderer 合同(`acpApiContract`)直接接到 runtime 上的控制器:renderer 的
 * start 输入里没有宿主签发的那几格 —— 其中 `runContext`(#5681)决定这次会话跑哪一份 CLI,
 * 没有宿主就答不出来。那样的控制器起出来的会话要么崩,要么静默跑错一份程序。
 */
export function createAcpRuntimeController(
  runtime: AcpRuntime,
  platformSessionClosed: EventStreamHost<typeof acpRuntimeApiContract.platformSessionClosed>,
  turnCommitted: EventStreamHost<typeof acpRuntimeApiContract.turnCommitted>
) {
  const procedures = createAcpProcedures(runtime);
  return createController(acpRuntimeApiContract, {
    ...procedures,
    sessions: runtime.sessionsLiveHost(),
    session: runtime.sessionLiveHost(),
    terminalOutput: (key) => runtime.terminalOutputLog(key.terminalId),
    platformSessionClosed,
    turnCommitted,
  });
}
