// #6264 桌面开窗口时报「我是哪一版」:咕咕 server 的账号进程记进这个账号的数据目录(守护进程据此让它跑匹配的版本);
// 协议在兼容窗口外 = 版本信号,留「当场换」请求。桌面自己(非 server)什么也不记。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth';
import { DESKTOP_REPORT_REFRESH_MS, readDesktopReports, readVersionSwitchRequest, VERSION_SWITCH_FILE } from '@gugu/core/cloud/serverDesktopVersions';
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

describe('taskhost.open 带来的桌面版本', () => {
  it('咕咕 server 上记下;协议超出兼容窗口留换版请求;形状不对的不记也不挡开窗口', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desktop-report-'));
    process.env.GUGU_SERVER_MODE = '1';
    process.env.GUGU_TASK_HOST_USER_DATA = dir;
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => host });
    const open = handlers['taskhost.open']!;
    expect(await open({ client: 'client0001', desktop: { id: 'mbp', version: '0.2.160', protocol: REMOTE_PROTOCOL_VERSION } }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(readDesktopReports(dir).mbp).toMatchObject({ version: '0.2.160', protocol: REMOTE_PROTOCOL_VERSION });
    expect(readVersionSwitchRequest(dir)).toBeNull();
    await open({ client: 'client0002', desktop: { id: 'next', version: '0.3.0', protocol: REMOTE_PROTOCOL_VERSION + 1 } }, ctx);
    expect(readVersionSwitchRequest(dir)).not.toBeNull();
    expect(await open({ client: 'client0003', desktop: { id: 'bad id', version: '0.1' } }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(Object.keys(readDesktopReports(dir)).sort()).toEqual(['mbp', 'next']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('桌面自己(不是咕咕 server):什么也不记', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desktop-report-'));
    delete process.env.GUGU_SERVER_MODE;
    process.env.GUGU_TASK_HOST_USER_DATA = dir;
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => host });
    await handlers['taskhost.open']!({ client: 'client0001', desktop: { id: 'mbp', version: '0.2.160', protocol: REMOTE_PROTOCOL_VERSION } }, ctx);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // #6914 改了这条线上的方法:比下沿旧的桌面开了窗口也只会在某个动作上半截失败 ⇒ 当场拒,说清是哪边旧。
  it('比 MIN_CLIENT_PROTOCOL 旧的桌面:桌面主机当场拒、不开窗口;不报协议的不下结论', async () => {
    delete process.env.GUGU_SERVER_MODE;
    const attach = vi.fn();
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => ({ attach }) as unknown as FrameSessionHost });
    const open = handlers['taskhost.open']!;
    const refused = await open({ client: 'client0001', desktop: { id: 'old', version: '0.2.51', protocol: MIN_CLIENT_PROTOCOL - 1 } }, ctx);
    expect(refused).toMatchObject({ error: { code: 'client_outdated' } });
    expect(attach).not.toHaveBeenCalled();
    // 对照:够新的、以及不报协议的(老到不报 = 不知道)照常开。
    expect(await open({ client: 'client0002', desktop: { id: 'new', version: '0.2.53', protocol: MIN_CLIENT_PROTOCOL } }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(await open({ client: 'client0003', desktop: { id: 'mute', version: '0.2.40' } }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(attach).toHaveBeenCalledTimes(2);
    // 手机不报 desktop,只报 protocol:同一个下沿。
    expect(await open({ client: 'client0004', protocol: MIN_CLIENT_PROTOCOL - 1 }, ctx)).toMatchObject({ error: { code: 'client_outdated' } });
    expect(await open({ client: 'client0005', protocol: MIN_CLIENT_PROTOCOL }, ctx)).toEqual({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } });
    expect(attach).toHaveBeenCalledTimes(3);
  });

  it('咕咕 server 拒旧桌面之前照样记下它、留换版请求(换成匹配的那一版之后它就开得了)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desktop-report-'));
    process.env.GUGU_SERVER_MODE = '1';
    process.env.GUGU_TASK_HOST_USER_DATA = dir;
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => host });
    const refused = await handlers['taskhost.open']!({ client: 'client0001', desktop: { id: 'old', version: '0.2.51', protocol: MIN_CLIENT_PROTOCOL - 1 } }, ctx);
    expect(refused).toMatchObject({ error: { code: 'client_outdated' } });
    expect(readDesktopReports(dir).old).toMatchObject({ version: '0.2.51', protocol: MIN_CLIENT_PROTOCOL - 1 });
    expect(readVersionSwitchRequest(dir)).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 老客户端被拒后每有一处界面在问就重开一次(mac1 实测空闲时约 6 秒一次):一小时内同一台只记一次。
  it('同一台旧桌面反复来开:一小时内只记一次,过了一小时再记', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desktop-report-'));
      process.env.GUGU_SERVER_MODE = '1';
      process.env.GUGU_TASK_HOST_USER_DATA = dir;
      const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => host });
      const open = handlers['taskhost.open']!;
      const old = { id: 'old', version: '0.2.51', protocol: MIN_CLIENT_PROTOCOL - 1 };
      await open({ client: 'client0001', desktop: old }, ctx);
      const first = readDesktopReports(dir).old!.at;
      // 守护进程处理完换版请求会删掉它;一小时内再来 ❌ 再留一个。
      fs.rmSync(path.join(dir, VERSION_SWITCH_FILE));
      vi.setSystemTime(new Date('2026-10-05T08:00:06Z'));
      expect(await open({ client: 'client0002', desktop: old }, ctx)).toMatchObject({ error: { code: 'client_outdated' } });
      expect(readDesktopReports(dir).old!.at).toBe(first);
      expect(readVersionSwitchRequest(dir)).toBeNull();
      vi.setSystemTime(new Date(Date.parse('2026-10-05T08:00:00Z') + DESKTOP_REPORT_REFRESH_MS));
      await open({ client: 'client0003', desktop: old }, ctx);
      expect(readDesktopReports(dir).old!.at).toBeGreaterThan(first);
      expect(readVersionSwitchRequest(dir)).not.toBeNull();
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('「更新没成功 · 重试」:咕咕 server 上留一个换版请求;桌面自己回 unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-desktop-report-'));
    process.env.GUGU_TASK_HOST_USER_DATA = dir;
    const { handlers } = createSessionHostDeviceRpcHandlers({ host: () => host });
    delete process.env.GUGU_SERVER_MODE;
    expect(await handlers['server.versionMatch.retry']!({}, ctx)).toMatchObject({ error: { code: 'unavailable' } });
    process.env.GUGU_SERVER_MODE = '1';
    expect(await handlers['server.versionMatch.retry']!({}, ctx)).toEqual({ result: { requested: true } });
    expect(readVersionSwitchRequest(dir)).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
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
    expect(await call({ channel: 'sessionTimeline.sessionAfter', args: [{ conversationId: 'c1' }] }, ctx)).toEqual({ result: { value: { ok: true, value: 1 } } });
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
