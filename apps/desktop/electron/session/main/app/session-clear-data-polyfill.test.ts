// #6264 — 没有 Electron 的宿主里 defaultSession 是普通对象;polyfill 若挂到它的原型(= Object.prototype)上,
// 进程里每个对象都多一个可枚举的 clearData,Supabase Realtime 遍历回调表时拿它 .filter,server 30 秒就崩。
import { afterEach, expect, it, vi } from 'vitest';
import { installClearDataPolyfill } from './session-clear-data-polyfill';

const protoHasClearData = () => Object.prototype.hasOwnProperty.call(Object.prototype, 'clearData');

afterEach(() => {
  delete (Object.prototype as { clearData?: unknown }).clearData;
});

it('普通对象当 session:只挂在实例上,Object.prototype 保持干净', async () => {
  const plain = { clearCache: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) };
  expect(installClearDataPolyfill(plain)).toBe(true);
  expect(protoHasClearData()).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(plain, 'clearData')).toBe(true);
  await (plain as unknown as { clearData: () => Promise<void> }).clearData();
  expect(plain.clearCache).toHaveBeenCalled();
});

it('已经有 clearData(原生或替身自带):不动', () => {
  const withIt = { clearCache: async () => {}, clearStorageData: async () => {}, clearData: async () => {} };
  expect(installClearDataPolyfill(withIt)).toBe(false);
  expect(protoHasClearData()).toBe(false);
});

it('真 Session 实例(有自己的原型):挂在原型上', () => {
  class FakeSession {
    async clearCache() {}
    async clearStorageData() {}
  }
  const instance = new FakeSession();
  expect(installClearDataPolyfill(instance)).toBe(true);
  expect(typeof (FakeSession.prototype as { clearData?: unknown }).clearData).toBe('function');
  expect(protoHasClearData()).toBe(false);
});
