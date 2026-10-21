/**
 * 改名前写下的本地存储键 → 现在的名字。
 *
 * 只改常量不搬值,老用户开机那一刻会被当成新用户:更新提醒重新弹一遍、自动化模板区的折叠状态丢掉。
 * 所以开机渲染之前把旧键里的值挪过去,再删掉旧键。
 */
export const RENAMED_LOCAL_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['emdash:update:lastNotified', 'gugu:update:lastNotified'],
  ['emdash-automation-template-section-collapsed', 'gugu-automation-template-section-collapsed'],
];

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** 新键已经有值就以新键为准(旧键只删不覆盖)。 */
export function migrateRenamedLocalStorageKeys(storage: KeyValueStorage): void {
  for (const [legacy, current] of RENAMED_LOCAL_STORAGE_KEYS) {
    const value = storage.getItem(legacy);
    if (value === null) continue;
    if (storage.getItem(current) === null) storage.setItem(current, value);
    storage.removeItem(legacy);
  }
}
