import { useEffect, useRef } from 'react';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { getSessionManagerStore, type sessionViewKind } from '@renderer/features/sessions/stores/session-selectors';
import { machineRegistry } from '@renderer/lib/machine-routing';

/**
 * #7199 这条会话所在的机器是一台没醒着的云电脑(休眠中 / 正在唤醒 / 叫醒没成)时交出它;别的情况 = null。
 * 醒了(连上了)而之前那一下准备文件 / 挂项目因为连不上失败了:自己重来一次 —— ❌ 让人醒了还对着「准备文件失败」去点重试。
 */
export function useCloudComputerGate(projectId: string, sessionId: string, kind: ReturnType<typeof sessionViewKind>) {
  const deviceId = machineRegistry.machineOf(projectId);
  const connection = deviceId ? remoteHostsStore.connectionState(deviceId) : null;
  const before = useRef(connection);
  const retryWhenConnected = useRef(false);
  useEffect(() => {
    const previous = before.current;
    before.current = connection;
    if (connection === 'connected' && (previous === 'asleep' || previous === 'waking' || previous === 'wake-failed')) retryWhenConnected.current = true;
    if (!retryWhenConnected.current || connection !== 'connected') return;
    if (kind !== 'provision-error' && kind !== 'project-error') return;
    retryWhenConnected.current = false;
    if (kind === 'project-error') void getProjectManagerStore().mountProject(projectId).catch(() => {});
    else void getSessionManagerStore(projectId)?.provisionSession(sessionId).catch(() => {});
  }, [connection, kind, projectId, sessionId]);
  if (!deviceId || (connection !== 'asleep' && connection !== 'waking' && connection !== 'wake-failed')) return null;
  return {
    deviceId,
    label: remoteHostsStore.device(deviceId)?.label ?? deviceId,
    failure: connection === 'wake-failed' ? remoteHostsStore.wakeFailure(deviceId) : null,
  };
}
