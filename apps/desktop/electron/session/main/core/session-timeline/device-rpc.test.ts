import { describe, expect, it } from 'vitest';

const { createSessionpageSessionDeviceRpcHandlers } = await import('./device-rpc');

describe('会话页在设备 RPC 上剩下的动词(一套说法:会话页与 agent 跨机器动作都走 taskhost)', () => {
  it('注册的只剩会话页宿主那条线', () => {
    const { handlers } = createSessionpageSessionDeviceRpcHandlers();
    expect(Object.keys(handlers).sort()).toEqual(
      [
        // 手机和别的桌面经这条频道用这台机器的整套会话页宿主(host-ws/device-session-host.ts)。
        'taskhost.open',
        'taskhost.frame',
        'taskhost.close',
        // 一问一答、不开窗口(手机回前台补齐;主进程 agent 跨机器的 agentSession.* 与列会话、归档)。
        'taskhost.call',
        // #6264 设备行「更新没成功 · 重试」(换成和桌面匹配的那一版)。
        'server.versionMatch.retry',
      ].sort()
    );
    // 阴控:手机原来那组动词、agent 跨机器原来那三个动词一个都不在了(老机器被「太旧」拦下,❌ 留垫片)。
    for (const gone of ['taskpage.session.snapshot', 'taskpage.session.keepalive', 'taskpage.sessions.list', 'taskpage.session.update', 'taskpage.agent.session']) {
      expect(handlers[gone]).toBeUndefined();
    }
  });
});
