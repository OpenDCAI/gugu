import { messageForUser } from '@/lib/userFacingError';
import type { AppSettings } from '@shared/core/app-settings';
import { toast } from '@renderer/lib/hooks/use-toast';
import { log } from '@renderer/utils/logger';
import {
  getAppSettingValueSnapshot,
  invalidateAppSettingsKey,
  setAppSettingsValueInCache,
  updateAppSettingsRequest,
} from './app-settings-client';

/**
 * 「这一步前问不问」类偏好的唯一一份读写 —— 它们都住在 `interface` 里、形状一样:出厂 = 问,
 * 确认框里的「不再询问」把它落成 false,设置 → 界面留一行把问题调回来。
 * 归档与「取消回合并发送」各用一个字段;❌ 每个确认框再抄一份这三个函数。
 */
export type InterfaceConfirmField = {
  [K in keyof AppSettings['interface']]: AppSettings['interface'][K] extends boolean ? K : never;
}[keyof AppSettings['interface']];

/** 设置还没读回来时按**问**走:一个读不到偏好的时刻不该替用户决定「不用问了」。 */
export function shouldConfirm(field: InterfaceConfirmField): boolean {
  return getAppSettingValueSnapshot('interface')?.[field] !== false;
}

/**
 * 只有拿得到整份 `interface` 才长出「不再询问」:主进程那侧 `update` 会拿 zod 全量 parse,少字段直接抛 ——
 * 拿半份去写等于把一个不会报错的复选框摆在那儿,勾了也不生效。
 */
export function canOfferDontAskAgain(): boolean {
  return getAppSettingValueSnapshot('interface') !== undefined;
}

export function stopAsking(
  field: InterfaceConfirmField,
  failure: { logTag: string; title: string; description: string }
): void {
  const current = getAppSettingValueSnapshot('interface');
  if (!current) return;
  const next = { ...current, [field]: false };
  setAppSettingsValueInCache('interface', next);
  updateAppSettingsRequest('interface', next).catch((error: unknown) => {
    // 写不进去就要说:否则下一次又弹,用户以为自己勾了个假的。
    log.error(`${failure.logTag} 保存「不再询问」失败`, { field, error: String(error) });
    toast({ title: failure.title, description: messageForUser(error), variant: 'destructive' });
    invalidateAppSettingsKey('interface');
  });
}
