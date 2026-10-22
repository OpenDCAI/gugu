/**
 * #6264 那台电脑正看着这台机器上的哪几条会话:`open_in_tab`(与这台机器上的程序「打开网页」)的 tab 开到那里去
 * (路由本身在 remote-pane.ts:有人看着就推、等回话;没人看着就攒着,下次有人打开这条会话时照开)。
 *
 * 看着 = 经会话页宿主那条连接订上。订阅的寿命就是连接的寿命:连接断了(关窗、合盖、网断)当场作废 ——
 * ❌ 另设保活与清扫;连回来之后那台电脑重订,攒着的请求随订阅应答一起送到。
 */
import { isSessionPaneTabs, type SessionpagePaneFailure } from '@gugu/session-core/session-record/contract';
import { SESSION_HOST_PANE, type SessionHostPaneSubscribe } from '@shared/lib/ipc/session-host-device-frames';
import type { RemotePaneRoute } from '@main/core/session-timeline/remote-pane';
import type { FrameSessionHost } from './frame-host';

type SenderEvent = { sender: { id: number } };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function installDevicePaneRelay(host: FrameSessionHost, route: Pick<RemotePaneRoute, 'subscribe' | 'unsubscribe' | 'ack'>): () => void {
  /** 连接 → 它订的那几条(断线时一并撤)。 */
  const owned = new Map<number, Set<string>>();
  const ownedBy = (sender: number) => {
    let set = owned.get(sender);
    if (!set) owned.set(sender, (set = new Set()));
    return set;
  };

  host.ipcMain.handle(SESSION_HOST_PANE.subscribe, (event, payload) => {
    const sender = (event as SenderEvent).sender.id;
    const body = asRecord(payload) as Partial<Record<keyof SessionHostPaneSubscribe, unknown>>;
    const subscriptionId = text(body.subscriptionId);
    const sessionId = text(body.sessionId);
    if (!subscriptionId || !sessionId) throw new Error('subscriptionId and sessionId are required');
    ownedBy(sender).add(subscriptionId);
    return route.subscribe(
      {
        subscriptionId,
        sessionId,
        browser: body.browser === true,
        pages: body.pages === true,
        external: body.external === true,
        tabs: body.tabs === true,
      },
      (open) => {
        host.sendTo(sender, SESSION_HOST_PANE.open, open);
      }
    );
  });

  host.ipcMain.handle(SESSION_HOST_PANE.unsubscribe, (event, subscriptionId) => {
    const sender = (event as SenderEvent).sender.id;
    const id = text(subscriptionId);
    if (!id || !owned.get(sender)?.delete(id)) return { unsubscribed: false };
    route.unsubscribe(id);
    return { unsubscribed: true };
  });

  host.ipcMain.handle(SESSION_HOST_PANE.opened, (event, payload) => {
    const sender = (event as SenderEvent).sender.id;
    const body = asRecord(payload);
    const subscriptionId = text(body.subscriptionId);
    const requestId = text(body.requestId);
    if (!subscriptionId || !requestId || !owned.get(sender)?.has(subscriptionId)) return { accepted: false };
    const failure: SessionpagePaneFailure | undefined =
      body.failure === 'no_browser' || body.failure === 'open_failed' ? body.failure : undefined;
    return { accepted: route.ack({ requestId, subscriptionId, ok: body.ok === true, failure,
      ...(isSessionPaneTabs(body.tabs) ? { tabs: body.tabs } : {}),
      ...(typeof body.closed === 'boolean' ? { closed: body.closed } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    }) };
  });

  const offClose = host.onConnectionClosed((sender) => {
    for (const id of owned.get(sender) ?? []) route.unsubscribe(id);
    owned.delete(sender);
  });

  return () => {
    offClose();
    for (const channel of [SESSION_HOST_PANE.subscribe, SESSION_HOST_PANE.unsubscribe, SESSION_HOST_PANE.opened]) {
      host.ipcMain.removeHandler(channel);
    }
  };
}
