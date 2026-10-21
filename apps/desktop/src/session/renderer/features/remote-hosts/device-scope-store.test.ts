import { describe, expect, it } from 'vitest';
import { LOCAL_DEVICE_SCOPE, DeviceScopeStore, deviceScopeTrayDevices } from './device-scope-store';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

function device(id: string, over: Partial<RemoteHostDevice> = {}): RemoteHostDevice {
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

describe('分机器的模块的机器选择(#6264)', () => {
  it('默认本机:这个窗口里从没选过时,选的与在用的都是本机', () => {
    const store = new DeviceScopeStore('gugu.library.device', memoryStorage());
    expect(store.selected).toBe(LOCAL_DEVICE_SCOPE);
    expect(store.effective(() => true)).toBe(LOCAL_DEVICE_SCOPE);
  });

  it('存不了(隐私模式 / 没有 sessionStorage)也默认本机,❌ 抛出来', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new DeviceScopeStore('gugu.library.device', throwing);
    expect(store.selected).toBe(LOCAL_DEVICE_SCOPE);
    store.select('d22');
    expect(store.selected).toBe('d22');
    expect(new DeviceScopeStore('gugu.library.device', null).selected).toBe(LOCAL_DEVICE_SCOPE);
  });

  it('选了哪台记在这个窗口里:同一个窗口重开(新 store 读同一份 sessionStorage)还停在那台', () => {
    const storage = memoryStorage();
    new DeviceScopeStore('gugu.library.device', storage).select('d22');
    expect(new DeviceScopeStore('gugu.library.device', storage).selected).toBe('d22');
  });

  it('选着的那台不在名下了 → 在用的回落本机,但选的那台留着(桥晚装好时它会回来)', () => {
    const store = new DeviceScopeStore('gugu.library.device', memoryStorage({ 'gugu.library.device': 'd22' }));
    expect(store.effective(() => false)).toBe(LOCAL_DEVICE_SCOPE);
    expect(store.selected).toBe('d22');
    expect(store.effective((id) => id === 'd22')).toBe('d22');
  });

  it('每个模块各记各的:资源库选了 d22,已安排仍是本机', () => {
    const storage = memoryStorage();
    new DeviceScopeStore('gugu.library.device', storage).select('d22');
    expect(new DeviceScopeStore('gugu.library.device', storage).selected).toBe('d22');
    expect(new DeviceScopeStore('gugu.automations.device', storage).selected).toBe(LOCAL_DEVICE_SCOPE);
  });

  it('选择器的行:本机第一行;别的机器带在线、上次在线、系统、没应答', () => {
    const rows = deviceScopeTrayDevices('本机', [
      { device: device('d22', { label: 'Linux 1' }), connection: 'reconnecting' },
      { device: device('d15', { label: 'Linux 2', isOnline: false, lastSeenAt: '2026-09-24T00:00:00Z' }), connection: 'offline' },
    ]);
    expect(rows[0]).toMatchObject({ id: LOCAL_DEVICE_SCOPE, label: '本机', isLocal: true, isOnline: true, kind: 'computer' });
    expect(rows[1]).toMatchObject({ id: 'd22', label: 'Linux 1', isLocal: false, isOnline: true, notResponding: true, platform: 'linux' });
    expect(rows[2]).toMatchObject({ id: 'd15', isOnline: false, lastSeenAt: '2026-09-24T00:00:00Z', notResponding: false });
  });

  it('#7199 个人助理住的那台不列(用户看不到它住在哪);对照:别的机器照列', () => {
    const rows = deviceScopeTrayDevices('本机', [
      { device: device('home', { label: '小咕', assistantHome: true }), connection: 'asleep' },
      { device: device('d22', { label: 'Linux 1' }), connection: 'connected' },
    ]);
    expect(rows.map((row) => row.id)).toEqual([LOCAL_DEVICE_SCOPE, 'd22']);
  });
});
