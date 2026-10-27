// 桌面这一侧「别的机器上有哪些会话」的那几问:与手机同一张路由表(sessionTimeline.*)、同一套窗口(machine-clients 的
// 那条连接),只是不经手机的 sessionpage-rpc。列表同步本身(底稿 → 订阅 → 合增量 → 断过再通就重来)是共享层那一份。
import type { SessionpageSessionsEvent } from '@gugu/session-core/session-record/contract';
import { events, rpcOn } from '@renderer/lib/ipc';
import { machineClient } from '@renderer/lib/machine-clients';
import { sessionpageSessionListChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import {
  linkChangesOf,
  type SessionpageSessionListClient,
} from '@/session/shared/remote-sessions/session-list-sync';

export const machineSessionListClient: SessionpageSessionListClient = {
  async subscribeSessionsList(deviceId, subscriptionId) {
    const result = await rpcOn(deviceId).sessionTimeline.sessionsSubscribe({ subscriptionId });
    // 那台机器回的 `{ok:false, error}`:原文与码原样带出来(码决定要不要重试,见 startSessionListSync)。
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  },
  unsubscribeSessionsList: (deviceId, subscriptionId) =>
    rpcOn(deviceId).sessionTimeline.sessionsUnsubscribe({ subscriptionId }),
  subscribeSessionsListEvents(deviceId, subscriptionId, onEvent) {
    if (deviceId === 'local') return events.on(sessionpageSessionListChannel, onEvent, subscriptionId);
    const client = machineClient(deviceId);
    if (!client) throw new Error(`no connection to ${deviceId}: the remote hosts bridge is not installed`);
    return client.api.eventOn(`${sessionpageSessionListChannel.name}.${subscriptionId}`, (event) =>
      onEvent(event as SessionpageSessionsEvent)
    );
  },
  onLinkChange(deviceId, cb) {
    if (deviceId === 'local') return () => undefined;
    const client = machineClient(deviceId);
    if (!client) throw new Error(`no connection to ${deviceId}: the remote hosts bridge is not installed`);
    return linkChangesOf(client, cb);
  },
};
