// #7103 人点的重试要真去问:先让宿主清掉这条会话签咕咕额度的退避,再重来。自动唤醒不走这里,照旧被退避挡着。
import { SESSIONPAGE_PLATFORM_RETRY_CHANNEL } from '@shared/core/agents/platform-model';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';

/** 清不掉(老版本宿主没有这条口、桥不在)只记一笔:重试照常走,最坏是退避窗口里拿回旧原因。 */
export async function askPlatformAgain(sessionId: string): Promise<void> {
  try {
    await invokeOnMachine(machineRegistry.machineOf(sessionId), SESSIONPAGE_PLATFORM_RETRY_CHANNEL, sessionId);
  } catch (error) {
    log.warn('platform retry: could not clear the issue backoff', { sessionId, error: String(error) });
  }
}
