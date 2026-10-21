import { useEffect, useRef } from 'react';
import { remoteHostsStore } from './remote-hosts-store';

/** 选中的那台此刻:睡着 / 别的样子 / 还不知道(设备表还没到)。 */
export type CloudWakeTarget = 'asleep' | 'other' | null;

/**
 * #7199 选中 / 打开一台睡着的云电脑:叫醒它,**每次选中只叫一次**(规定草稿 cloud-computer「点了先叫醒它」)。
 * 页面开着时它又睡着了 ❌ 再叫 —— 那样它永远睡不着、一直扣积分;要再叫就换一台再选回来,或在机器选择器里再点它。
 * 设备表还没到(null)时先不算这一次,到了再看。
 */
export function useWakeCloudOnce(deviceId: string | null, target: CloudWakeTarget): void {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!deviceId || target === null) return;
    if (handled.current === deviceId) return;
    handled.current = deviceId;
    if (target === 'asleep') void remoteHostsStore.wakeCloudComputer(deviceId);
  }, [deviceId, target]);
}

/**
 * #7199 以一台睡着的云电脑为目标的新建框:**开始输入**(打字 / 贴附件)才叫醒它 —— 光打开新建框、选它做目标 ❌ 叫醒
 * (看一眼不该扣积分);醒要 20 秒左右,打完字基本就醒了。只认真的改动:挂上时带进来的草稿、换机器时原样留着的草稿不算;
 * 叫醒没成之后不每敲一个字再叫一次(在机器选择器里再点它 = 再叫)。`input` = 能比出「改了没有」的一个串。
 */
export function useWakeCloudOnInput(deviceId: string | null, input: string): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const previous = last.current;
    last.current = input;
    if (previous === null || previous === input) return;
    if (!deviceId || remoteHostsStore.connectionState(deviceId) !== 'asleep') return;
    void remoteHostsStore.wakeCloudComputer(deviceId);
  }, [deviceId, input]);
}
