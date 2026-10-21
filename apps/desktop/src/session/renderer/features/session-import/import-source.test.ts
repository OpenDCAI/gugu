import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import type { LocalSessionRow } from '@shared/core/session-import/session-import';

const ipc = vi.hoisted(() => ({
  listLocalSessions: vi.fn(),
  previewLocalSession: vi.fn(),
  importLocalSession: vi.fn(),
}));
/** 别的机器那一侧:同一组 `sessionImport.*` 动词,rpcOn(机器) 送过去。 */
const machine = vi.hoisted(() => ({
  calls: [] as Array<{ machine: string; verb: string; params: unknown }>,
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sessionImport: ipc },
  rpcOn: (id: string) => ({
    sessionImport: {
      listLocalSessions: async (params: unknown) => {
        machine.calls.push({ machine: id, verb: 'list', params });
        return { rows: [], matched: 0, discovered: 0, indexed: 0, pending: 0, countsByEngine: { 'claude-code': 0, codex: 0 }, stale: false };
      },
      previewLocalSession: async (params: unknown) => {
        machine.calls.push({ machine: id, verb: 'preview', params });
        return { providerSessionId: 's', title: 't', cwd: '/w', turnCount: 0, head: [], tail: [] };
      },
      importLocalSession: async (params: unknown) => {
        machine.calls.push({ machine: id, verb: 'import', params });
        return { projectId: 'p-d22', sessionId: 'c-d22', workingDirectory: '/home/me/work', alreadyImported: false };
      },
    },
  }),
}));

const { LOCAL_IMPORT_DEVICE, resolveImportSource } = await import('./import-source');
const { describeImportFailure, importDeviceChoices, importDeviceState } = await import('./import-device');
const { runImport } = await import('./import-runner');

/** 假翻译:key + 插值,够看出选了哪一句、带没带机器名。 */
const translate = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(',')})` : key) as never;

function host(overrides: Partial<RemoteHostDevice> = {}): RemoteHostDevice {
  return {
    id: 'dev-d22',
    label: 'd22',
    isOnline: true,
    platform: 'linux',
    lastSeenAt: '2026-09-24T08:00:00Z',
    sessionDigest: null,
    directTerminal: true,
    ...overrides,
  };
}

const ROW: LocalSessionRow = {
  engine: 'codex',
  providerSessionId: 'sess-1',
  title: '给结算服务补幂等键',
  cwd: '/home/me/work',
  filePath: '/home/me/.codex/sessions/rollout-a.jsonl',
  updatedAt: 0,
  sizeBytes: 1,
};

describe('#6264 导入会话按机器切换', () => {
  beforeEach(() => {
    for (const fn of Object.values(ipc)) fn.mockReset();
    machine.calls.length = 0;
  });

  it('#7199 个人助理住的那台不在「从哪台导入」里;对照:别的机器照列', () => {
    const choices = importDeviceChoices('本地', [host({ id: 'home', assistantHome: true }), host()]);
    expect(choices.map((choice) => choice.id)).toEqual([LOCAL_IMPORT_DEVICE, host().id]);
  });

  it('默认本机:本机排第一、走任务页 IPC,❌ 碰设备 RPC', async () => {
    const choices = importDeviceChoices('本地', [host()]);
    expect(choices[0]).toMatchObject({ id: LOCAL_IMPORT_DEVICE, isLocal: true, isOnline: true });
    expect(importDeviceState(LOCAL_IMPORT_DEVICE, choices)).toMatchObject({ blocked: null });

    const source = resolveImportSource(LOCAL_IMPORT_DEVICE);
    expect(source.isLocal).toBe(true);
    await source.list({ mode: 'cached' });
    expect(ipc.listLocalSessions).toHaveBeenCalledWith({ mode: 'cached' });
    expect(machine.calls).toEqual([]);
  });

  it('选了 d22:列表与预览问的是 d22(同一组动词,扫它自己的磁盘)', async () => {
    const source = resolveImportSource('dev-d22');
    expect(source.isLocal).toBe(false);
    await source.list({ engine: 'codex', mode: 'fresh', hydrateBudgetMs: 400 });
    await source.preview({ filePath: ROW.filePath, engine: 'codex' });
    expect(machine.calls).toEqual([
      { machine: 'dev-d22', verb: 'list', params: { engine: 'codex', mode: 'fresh', hydrateBudgetMs: 400 } },
      { machine: 'dev-d22', verb: 'preview', params: { filePath: ROW.filePath, engine: 'codex' } },
    ]);
    expect(ipc.listLocalSessions).not.toHaveBeenCalled();
    expect(ipc.previewLocalSession).not.toHaveBeenCalled();
  });

  it('选了 d22 再导入:会话建在 d22 上(原件在哪台就归哪台),❌ 导进本机;SSH 装上的机器照旧进终端', async () => {
    const progress: number[] = [];
    const source = resolveImportSource('dev-d22', true);
    expect(source.sessionView).toBe('code');
    const outcomes = await runImport(source, [ROW], (n) => progress.push(n), String);
    expect(machine.calls).toEqual([
      {
        machine: 'dev-d22',
        verb: 'import',
        params: { engine: 'codex', providerSessionId: 'sess-1', filePath: ROW.filePath, title: ROW.title, cwd: ROW.cwd },
      },
    ]);
    expect(ipc.importLocalSession).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { kind: 'imported', row: ROW, projectId: 'p-d22', sessionId: 'c-d22' },
    ]);
    expect(progress).toEqual([1]);
  });

  it('只经远程隧道连着的机器(没有终端):导入要「通用」,会话在聊天腿里续原会话,❌ 建一条打不开的终端会话', async () => {
    const source = resolveImportSource('dev-tunnel', false);
    expect(source.sessionView).toBe('general');
    await runImport(source, [ROW], () => {}, String);
    expect(machine.calls[0]).toMatchObject({ machine: 'dev-tunnel', verb: 'import', params: { providerSessionId: 'sess-1', sessionView: 'general' } });
  });

  it('离线的机器照样列着(灰、带上次在线),选中了也不去扫、不能导', () => {
    const choices = importDeviceChoices('本地', [host({ isOnline: false })]);
    const d22 = choices.find((choice) => choice.id === 'dev-d22');
    // MachinePicker 按 isOnline=false 把这一项淡下去、写「离线 · X 前」。
    expect(d22).toMatchObject({ isOnline: false, lastSeenAt: '2026-09-24T08:00:00Z' });
    expect(importDeviceState('dev-d22', choices)).toMatchObject({ blocked: 'offline' });
    // 选着的机器被移出名下:仍停在它上面说清楚,❌ 静默跳回本机。
    expect(importDeviceState('dev-gone', choices)).toEqual({ device: null, blocked: 'gone' });
  });

  it('老 server 不认导入动词:说「版本太旧、空闲会自己升级」,❌ 报错码', () => {
    const tooOld = Object.assign(new Error('unknown method taskpage.sessionImport.list'), { code: 'unknown_method' });
    const text = describeImportFailure(tooOld, { isLocal: false }, 'd22', 'list', translate);
    expect(text).toBe('sessionImport.serverTooOld(device=d22)');
    expect(text).not.toContain('unknown_method');
  });

  it('其余失败:没问到(无业务码)说连不上那台机器;那台机器的人话原样说;本机剥掉 IPC 的壳', () => {
    expect(describeImportFailure(new Error('Device RPC timed out after 12000ms'), { isLocal: false }, 'd22', 'list', translate)).toBe(
      'sessionImport.remoteUnreachable(device=d22)'
    );
    expect(
      describeImportFailure(Object.assign(new Error('x'), { code: 'import_unavailable' }), { isLocal: false }, 'd22', 'list', translate)
    ).toBe('sessionImport.remoteUnavailable(device=d22)');
    expect(
      describeImportFailure(Object.assign(new Error('目录已经不在了：/w'), { code: 'import_failed' }), { isLocal: false }, 'd22', 'import', translate)
    ).toBe('目录已经不在了：/w');
    expect(
      describeImportFailure(
        new Error("Error invoking remote method 'sessionImport.listLocalSessions': Error: 读不到索引"),
        { isLocal: true },
        '本地',
        'list',
        translate
      )
    ).toBe('sessionImport.listFailed(error=读不到索引)');
  });
});
