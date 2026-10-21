import { describe, expect, it } from 'vitest';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import type { Translate } from './connection-status';
import {
  localMachineChoice,
  machineChoiceFromHost,
  machineMeta,
  orderMachines,
  platformHint,
  type MachineChoice,
} from './machine-choice';

const zh: Record<string, string> = {
  'machinePicker.offline': '离线',
  'machinePicker.needsSignIn': '要先登录',
  'machinePicker.updating': '正在更新…',
  'machinePicker.tooOld': '版本太旧',
  'machinePicker.offlineSince': '离线 · {time}',
  'machinePicker.notResponding': '没有应答',
  'machinePicker.linkSsh': '远程 SSH',
  'machinePicker.linkTunnel': '远程隧道',
};
const translate = ((key: string, values?: Record<string, unknown>) =>
  (zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''))) as Translate;

const machine = (patch: Partial<MachineChoice> & { id: string }): MachineChoice => ({
  label: patch.id,
  isLocal: false,
  isOnline: true,
  ...patch,
});

function host(id: string, over: Partial<RemoteHostDevice> = {}): RemoteHostDevice {
  return {
    id,
    label: id,
    isOnline: true,
    platform: 'linux',
    lastSeenAt: null,
    sessionDigest: null,
    directTerminal: false,
    ...over,
  };
}

describe('机器选择器的一行(#6264,各处同一份)', () => {
  it('本机第一,然后在线的按名字,最后离线的(最近在线的在前)', () => {
    const ordered = orderMachines([
      machine({ id: 'off-old', isOnline: false, lastSeenAt: '2026-09-01T00:00:00Z' }),
      machine({ id: 'zeta' }),
      machine({ id: 'off-new', isOnline: false, lastSeenAt: '2026-09-20T00:00:00Z' }),
      machine({ id: 'local', isLocal: true }),
      machine({ id: 'alpha' }),
      machine({ id: 'off-never', isOnline: false }),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['local', 'alpha', 'zeta', 'off-new', 'off-old', 'off-never']);
  });

  it('系统提示只认得出的三种,认不出不标', () => {
    expect(platformHint('linux')).toBe('Linux');
    expect(platformHint('darwin')).toBe('macOS');
    expect(platformHint('mac')).toBe('macOS');
    expect(platformHint('win32')).toBe('Windows');
    expect(platformHint('freebsd')).toBeNull();
    expect(platformHint(undefined)).toBeNull();
  });

  it('种类与连法:咕咕 server 是服务器;SSH 装上的写远程 SSH,只经云的 server 写远程隧道;老桌面不报种类 = 电脑、不标连法', () => {
    expect(machineChoiceFromHost(host('d22', { hostKind: 'server', directTerminal: true }), 'connected')).toMatchObject({
      kind: 'server',
      link: 'ssh',
      notResponding: false,
    });
    expect(machineChoiceFromHost(host('t1', { hostKind: 'server' }), null)).toMatchObject({ kind: 'server', link: 'tunnel' });
    // 别的电脑用远程 SSH 加的:这台没有直连,照样写远程 SSH(❌ 写成远程隧道)。
    expect(machineChoiceFromHost(host('d22', { hostKind: 'server', connectVia: 'ssh' }), null)).toMatchObject({ kind: 'server', link: 'ssh' });
    expect(machineChoiceFromHost(host('mbp', { platform: 'darwin' }), 'reconnecting')).toMatchObject({
      kind: 'computer',
      link: null,
      notResponding: true,
    });
    expect(localMachineChoice('local', '本机')).toMatchObject({ isLocal: true, isOnline: true, kind: 'computer' });
  });

  it('名字后面那段字:触发器只写系统,菜单再带连法;离线写「离线 · X 前」,问不通写「没有应答」', () => {
    const d22 = machine({ id: 'd22', platform: 'linux', link: 'ssh' });
    expect(machineMeta(d22, translate)).toBe('Linux');
    expect(machineMeta(d22, translate, { withLink: true })).toBe('Linux · 远程 SSH');
    expect(machineMeta(machine({ id: 't', platform: 'linux', link: 'tunnel' }), translate, { withLink: true })).toBe(
      'Linux · 远程隧道'
    );
    expect(machineMeta(machine({ id: 'x', notResponding: true, platform: 'linux' }), translate)).toBe('没有应答');
    const off = machine({ id: 'off', isOnline: false, lastSeenAt: '2026-09-24T08:00:00Z' });
    expect(machineMeta(off, translate, { nowMs: Date.parse('2026-09-24T08:05:00Z') })).toMatch(/^离线 · .+/);
    expect(machineMeta(machine({ id: 'never', isOnline: false }), translate)).toBe('离线');
    // 系统认不出、也没有连法:不写字,❌ 留一个空的分隔点。
    expect(machineMeta(machine({ id: 'bsd', platform: 'freebsd' }), translate, { withLink: true })).toBeNull();
  });

  it('#6264 那台机器的 server 太旧:选择器里说「正在更新…」/「版本太旧」,❌「没有应答」「离线」', () => {
    const d22 = host('d22', { directTerminal: true });
    expect(machineMeta(machineChoiceFromHost(d22, 'updating'), translate)).toBe('正在更新…');
    expect(machineMeta(machineChoiceFromHost(d22, 'update-failed'), translate)).toBe('版本太旧');
    expect(machineMeta(machineChoiceFromHost(host('t'), 'outdated'), translate)).toBe('版本太旧');
    expect(machineChoiceFromHost(d22, 'updating').notResponding).toBe(false);
  });

  it('#6264 远程 SSH 要先登录:选择器里写「要先登录」,❌ 写离线', () => {
    const choice = machineChoiceFromHost(host('d22', { hostKind: 'server', directTerminal: true, isOnline: false }), 'sign-in');
    expect(choice.needsSignIn).toBe(true);
    expect(machineMeta(choice, translate)).toBe('要先登录');
  });
});
