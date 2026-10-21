// #7199 健康 —— 「助理」App 健康页要的那一份:经设备动作问主人自己的手机(health.summary),与云电脑上的助理 device_call 同一条路。
// 主进程问:设备 RPC 的请求方、令牌都在这边(main.ts 的 deviceActionCaller,启动时注入)。
// 读不到要如实说是哪一种:没有登记过的手机 / 手机上的咕咕太旧 / 手机离线 / 没连「健康」/ 系统没给 / 这台手机不支持 / 读失败。
// 纯判断在 pickHealthPhone / healthReadOf(有单测),❌ 把「没有」画成「0」。
import type { DeviceActionDeviceView } from '@gugu/core/cloud/deviceActionCaller';
import type { DeviceActionResult } from '@gugu/core/shared/deviceActions';

export const HEALTH_GROUP = 'health';
export const HEALTH_SUMMARY_ACTION = 'health.summary';

export type PhoneHealthCaller = {
  describe(): Promise<DeviceActionDeviceView[]>;
  call(input: { deviceId: string; action: string; args: Record<string, unknown>; caller: { name: string } }): Promise<DeviceActionResult>;
};

let caller: PhoneHealthCaller | null = null;

export function setPhoneHealthCaller(next: PhoneHealthCaller): void {
  caller = next;
}

type PhoneRef = { deviceId: string; label: string; lastSeenAt: string | null };

export type PhoneHealthRead =
  | { state: 'no-phone' }
  /** 有手机登记过,但那台的咕咕还没有「健康」这一组(版本旧)。 */
  | ({ state: 'old-app' } & PhoneRef)
  | ({ state: 'offline' } & PhoneRef)
  | ({ state: 'not_granted' | 'os_permission' | 'unsupported'; detail: string | null } & PhoneRef)
  | ({ state: 'failed'; code: string; message: string } & PhoneRef)
  | ({ state: 'ok'; data: unknown; readAt: string } & PhoneRef);

const ref = (device: DeviceActionDeviceView): PhoneRef => ({ deviceId: device.device_id, label: device.label, lastSeenAt: device.last_seen_at });
const isPhone = (device: DeviceActionDeviceView) => device.platform === 'android' || device.platform === 'ios' || device.device_id.startsWith('phone-');

/**
 * 挑哪台手机:登记了「健康」这一组的里面,在线且能用的 > 在线的 > 最近在线的;一台都没有就看有没有别的手机(=咕咕太旧)。
 * 不带 deviceId 的 describe 是分组汇总(groups)。
 */
export function pickHealthPhone(devices: DeviceActionDeviceView[]): PhoneHealthRead | { state: 'call'; device: DeviceActionDeviceView } {
  const withHealth = devices.filter((d) => d.groups?.some((g) => g.group === HEALTH_GROUP));
  if (withHealth.length === 0) {
    const phone = devices.filter(isPhone).sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))[0];
    return phone ? { state: 'old-app', ...ref(phone) } : { state: 'no-phone' };
  }
  const group = (d: DeviceActionDeviceView) => d.groups!.find((g) => g.group === HEALTH_GROUP)!;
  const ranked = [...withHealth].sort(
    (a, b) =>
      Number(b.online && group(b).available) - Number(a.online && group(a).available) ||
      Number(b.online) - Number(a.online) ||
      (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '')
  );
  const device = ranked[0]!;
  if (!device.online) return { state: 'offline', ...ref(device) };
  const health = group(device);
  if (!health.available) {
    const reason = health.unavailable_reason;
    const state = reason === 'os_permission' || reason === 'unsupported' ? reason : 'not_granted';
    return { state, detail: health.unavailable_detail ?? null, ...ref(device) };
  }
  return { state: 'call', device };
}

/** 调用的结果 → 页面的状态。设备在调用时才发现的(离线、权限被收回)照样分开说。 */
export function healthReadOf(device: DeviceActionDeviceView, result: DeviceActionResult, now: Date): PhoneHealthRead {
  if (result.ok) return { state: 'ok', data: result.data, readAt: now.toISOString(), ...ref(device) };
  if (result.code === 'device_offline' || result.code === 'no_answer') return { state: 'offline', ...ref(device) };
  if (result.code === 'not_granted' || result.code === 'revoked') return { state: 'not_granted', detail: result.message, ...ref(device) };
  if (result.code === 'os_permission') return { state: 'os_permission', detail: result.message, ...ref(device) };
  if (result.code === 'unsupported' || result.code === 'unknown_action') return { state: 'old-app', ...ref(device) };
  return { state: 'failed', code: result.code, message: result.message, ...ref(device) };
}

export async function readPhoneHealth(days: number): Promise<PhoneHealthRead> {
  if (!caller) throw new Error('device actions are not wired in this process');
  const picked = pickHealthPhone(await caller.describe());
  if (picked.state !== 'call') return picked;
  const result = await caller.call({
    deviceId: picked.device.device_id,
    action: HEALTH_SUMMARY_ACTION,
    args: { days },
    caller: { name: '助理 App 的健康页' },
  });
  return healthReadOf(picked.device, result, new Date());
}
