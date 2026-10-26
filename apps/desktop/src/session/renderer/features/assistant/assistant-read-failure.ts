import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTooOld } from '@renderer/features/library/library-host';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

/** 读它家里东西没读成时那一块说什么:`retry` 为 null = 不给按钮(在等,点了也一样)。 */
export type ReadFailure = { text: string; tone: 'quiet' | 'danger'; retry: (() => void) | null };

/**
 * #7403 读它家里东西没读成时那一句话(product spec 第 5 条例外)。
 *  · 那台的咕咕比这台桌面旧、不认这一问:当场请它换成匹配的版本,说「正在更新」—— ❌ 红字、❌ 原始错误、
 *    ❌ 重读一次结果也一样的「重试」。换好了(心跳报的版本变了)自己重读,❌ 轮询。
 *  · 那台报换版本没成,或这一请根本没请到(太老不认 / 连不上):说「没更新成功」+「重试」(再请它换一次)。
 *  · 别的失败照实说原因(❌ 带 `Error:` 前缀)+ 重读。
 * `deviceId` = 它家那台(这台电脑自己 = null);`where` = 句子里怎么叫那台。要在 observer 组件里用。
 */
export function useReadFailure(error: unknown, deviceId: string | null, where: string, reload: () => void): ReadFailure | null {
  const { t } = useTranslation('assistant');
  const device = deviceId ? remoteHostsStore.device(deviceId) : null;
  const outdated = Boolean(error) && device !== null && isTooOld(error);
  const version = device?.version ?? null;
  // 这一次请它换没请到(那台太老不认这一请 / 连不上):❌ 一直说「正在更新」,说没能更新 + 重试。
  const asked = `${deviceId ?? ''}@${version ?? ''}`;
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (!outdated || !deviceId) return;
    let live = true;
    void remoteHostsStore.matchServerVersion(deviceId).then((requested) => {
      if (live) setRefused(requested ? null : asked);
    });
    return () => {
      live = false;
    };
  }, [outdated, deviceId, asked]);
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!outdated) {
      seen.current = undefined;
      return;
    }
    if (seen.current === undefined) seen.current = version;
    else if (seen.current !== version) {
      seen.current = version;
      reload();
    }
  }, [outdated, version, reload]);
  if (!error) return null;
  if ((error as { code?: string }).code === 'unprepared') return { text: t('machine.unprepared'),tone: 'quiet',retry: reload };
  if ((error as { code?: string }).code === 'collection-unavailable') return { text: t('machine.collectionFailed'),tone: 'danger',retry: reload };
  if (outdated && deviceId) {
    const retry = () =>
      void remoteHostsStore.matchServerVersion(deviceId, { retry: true }).then((requested) => setRefused(requested ? null : asked));
    if (device?.serverUpdate === 'failed' || device?.sshLink === 'outdated' || refused === asked)
      return { text: t('machine.updateFailed', { where }), tone: 'quiet', retry };
    return { text: t('machine.updating', { where }), tone: 'quiet', retry: null };
  }
  return { text: t('machine.readFailed', { message: error instanceof Error ? error.message : String(error) }), tone: 'danger', retry: reload };
}
