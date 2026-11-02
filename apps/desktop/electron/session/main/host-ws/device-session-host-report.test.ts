// #6264 桌面开窗口时报「我是哪一版」:咕咕 server 的账号进程记进这个账号的数据目录(守护进程据此让它跑匹配的版本);
// 协议在兼容窗口外 = 版本信号,留「当场换」请求。桌面自己(非 server)什么也不记。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth';
import type { DeviceRpcHandlerContext } from '@gugu/core/cloud/deviceRpcResponder';
import { createSessionHostDeviceRpcHandlers } from './device-session-host';
import { FrameSessionHost } from './frame-host';

const saved = { mode: process.env.GUGU_SERVER_MODE, data: process.env.GUGU_TASK_HOST_USER_DATA };
afterEach(() => {
  process.env.GUGU_SERVER_MODE = saved.mode;
  process.env.GUGU_TASK_HOST_USER_DATA = saved.data;
  if (saved.mode === undefined) delete process.env.GUGU_SERVER_MODE;
  if (saved.data === undefined) delete process.env.GUGU_TASK_HOST_USER_DATA;
});

const ctx = { publishEvent: () => undefined, request: { user_id: 'owner' } } as unknown as DeviceRpcHandlerContext;
const host = { attach: vi.fn() } as unknown as FrameSessionHost;

describe('taskhost.open accepts only protocol facts from released desktop reports', () => {
  it('opens compatible peers without writing reports, requests or account update state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-no-desktop-state-'));
    process.env.GUGU_SERVER_MODE = '1'; process.env.GUGU_TASK_HOST_USER_DATA = dir;
    const { handlers, dispose } = createSessionHostDeviceRpcHandlers({ host: () => host });
    try {
      for (const protocol of [MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION, REMOTE_PROTOCOL_VERSION + 1]) {
        expect(await handlers['taskhost.open']!({ client: 'client0001', desktop: { id: 'same-device:new-version', version: '9.0.0', protocol } }, ctx))
          .toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
      }
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(handlers['server.versionMatch.retry']).toBeUndefined();
      expect(handlers['server.versionMatch.retryWhenIdle']).toBeUndefined();
      expect(handlers['server.versionMatch.restartNow']).toBeUndefined();
    } finally { dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('still enforces the same protocol floor for old desktop and modern protocol fields', async () => {
    const attach = vi.fn();
    const { handlers, dispose } = createSessionHostDeviceRpcHandlers({ host: () => ({ attach }) as unknown as FrameSessionHost });
    const open = handlers['taskhost.open']!;
    try {
      expect(await open({ client: 'client0001', desktop: { id: 'old', version: '1.0.0', protocol: MIN_CLIENT_PROTOCOL - 1 } }, ctx))
        .toMatchObject({ error: { code: 'client_outdated' } });
      expect(await open({ client: 'client0002', protocol: MIN_CLIENT_PROTOCOL - 1 }, ctx)).toMatchObject({ error: { code: 'client_outdated' } });
      expect(attach).not.toHaveBeenCalled();
      expect(await open({ client: 'client0003', protocol: MIN_CLIENT_PROTOCOL }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
      expect(await open({ client: 'client0004' }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
      expect(attach).toHaveBeenCalledTimes(2);
    } finally { dispose(); }
  });
});

describe('taskhost.call(一问一答,不开窗口)', () => {
  it('can read and edit the host books while window controls and unlisted app calls remain refused', async () => {
    const frameHost = new FrameSessionHost();
    const entry = { id: 'phone-trial', content: 'old' };
    frameHost.ipcMain.handle('app.getUserLibrary', () => ({ capabilities: [entry] }));
    frameHost.ipcMain.handle('app.getUserLibraryVolume', (_event, kind) => ({ volume: { kind }, items: [entry] }));
    frameHost.ipcMain.handle('app.readUserLibraryEntry', (_event, kind, id) => ({ kind, id, content: entry.content }));
    const assistantApp = vi.fn((_event, verb, args, expectedOwnerId) => ({ verb, args, expectedOwnerId }));
    frameHost.ipcMain.handle('app.assistantAppCall', assistantApp);
    frameHost.ipcMain.handle('app.writeUserLibraryEntry', (_event, input) => {
      entry.content = (input as { content: string }).content;
      return entry;
    });
    const forbidden = vi.fn();
    for (const channel of ['app.closeWindow', 'app.getUserLibraryVolumeExtra', 'app.assistantAppCallExtra', 'browser.open']) frameHost.ipcMain.handle(channel, forbidden);
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => frameHost });
    const call = (channel: string, args: unknown[] = []) => handlers['taskhost.call']!({ channel, args }, ctx);
    expect(await call('app.getUserLibrary')).toMatchObject({ result: { value: { capabilities: [entry] } } });
    expect(await call('app.getUserLibraryVolume', ['capabilities'])).toMatchObject({ result: { value: { volume: { kind: 'capabilities' } } } });
    expect(await call('app.writeUserLibraryEntry', [{ kind: 'capabilities', id: entry.id, content: 'new' }])).toMatchObject({ result: { value: { content: 'new' } } });
    expect(await call('app.readUserLibraryEntry', ['capabilities', entry.id])).toMatchObject({ result: { value: { content: 'new' } } });
    expect(await call('app.assistantAppCall', ['callProgram', { name: 'assistant_work_list', arguments: {} }, 'owner']))
      .toMatchObject({ result: { value: { verb: 'callProgram', args: { name: 'assistant_work_list', arguments: {} }, expectedOwnerId: 'owner' } } });
    expect(assistantApp).toHaveBeenCalledOnce();
    expect(await call('app.assistantAppCall', ['callProgram', { name: 'library_write', arguments: {} }, 'owner']))
      .toMatchObject({ error: { message: expect.stringContaining('No handler registered') } });
    expect(await handlers['taskhost.call']!({ channel: 'app.assistantAppCall', args: ['callProgram', { name: 'assistant_work_clear' }, 'owner'] },
      { ...ctx, request: { ...ctx.request, user_id: 'other' } }))
      .toMatchObject({ error: { message: expect.stringContaining('No handler registered') } });
    expect(assistantApp).toHaveBeenCalledOnce();
    for (const channel of ['app.closeWindow', 'app.getUserLibraryVolumeExtra', 'app.assistantAppCallExtra', 'browser.open']) expect(await call(channel)).toMatchObject({ error: { message: expect.stringContaining('No handler registered') } });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('runs the call through the host with the remote policy; a failure comes back as {code, message}; a bad payload is refused', async () => {
    const invokeOnce = vi.fn(async (channel: string, _args: unknown[], _policy?: (channel: string) => boolean) => {
      if (channel === 'boom.now') throw Object.assign(new Error('nope'), { code: 'session_not_found' });
      return { ok: true, value: 1 };
    });
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => ({ invokeOnce }) as unknown as FrameSessionHost });
    const call = handlers['taskhost.call']!;
    expect(await call({ channel: 'sessionTimeline.sessionAfter', args: [{ conversationId: 'c1' }] }, ctx)).toEqual({ result: { value: { ok: true, value: 1 }, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(invokeOnce).toHaveBeenCalledWith('sessionTimeline.sessionAfter', [{ conversationId: 'c1' }], expect.any(Function));
    // the remote policy is the one windows get: the viewing computer's namespaces stay refused
    const policy = invokeOnce.mock.calls[0]![2]!;
    expect(policy('browser.open')).toBe(false);
    expect(await call({ channel: 'boom.now', args: [] }, ctx)).toEqual({ error: { code: 'session_not_found', message: 'nope' } });
    expect(await call({ channel: 1, args: [] }, ctx)).toMatchObject({ error: { code: 'invalid_payload' } });
  });
});

// #7233 开窗口的发问端那条线没了(宿主空闲关 / 让位 / 收摊):帧推不过去了,窗口一并关掉 —— ❌ 留着「以为还有人在看」。
describe('窗口随开它的发问端一起关', () => {
  it('发问端离开:经它开的窗口关掉;别的发问端开的照旧', async () => {
    delete process.env.GUGU_SERVER_MODE;
    const sockets: { onClose(cb: () => void): void }[] = [];
    const attach = vi.fn((socket: { onClose(cb: () => void): void }) => sockets.push(socket));
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => ({ attach }) as unknown as FrameSessionHost });
    const detachers = new Map<string, () => void>();
    const askerCtx = (id: string) => ({
      publishEvent: () => undefined,
      asker: { id, onDetached: (cb: () => void) => { detachers.set(id, cb); return () => detachers.delete(id); } },
    }) as unknown as DeviceRpcHandlerContext;
    await handlers['taskhost.open']!({ client: 'clientA001', protocol: REMOTE_PROTOCOL_VERSION }, askerCtx('askerAAAA1111'));
    await handlers['taskhost.open']!({ client: 'clientB001', protocol: REMOTE_PROTOCOL_VERSION }, askerCtx('askerBBBB2222'));
    const closed = sockets.map(() => vi.fn());
    sockets.forEach((socket, i) => socket.onClose(closed[i]!));

    detachers.get('askerAAAA1111')!();
    expect(closed[0]).toHaveBeenCalledTimes(1);
    expect(closed[1]).not.toHaveBeenCalled();
    expect(await handlers['taskhost.frame']!({ client: 'clientA001', seq: 0, frames: [] }, askerCtx('askerAAAA1111'))).toMatchObject({ error: { code: 'not_open' } });
  });
});
