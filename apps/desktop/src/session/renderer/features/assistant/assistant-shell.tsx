import { useCallback, useSyncExternalStore } from 'react';
import {
  assistantSlotKey,
  readAssistantShellBridge,
  type AssistantShellSlot,
  type AssistantShellSnapshot,
} from '@/lib/assistantShellBridge';
import { readShellSlots } from '@/lib/shellSlots';

/** 壳发布的「此刻的样子」(云电脑、个人助理是谁);壳还没挂上 = null。 */
export function useAssistantShell(): AssistantShellSnapshot | null {
  const bridge = readAssistantShellBridge();
  return useSyncExternalStore(
    (listener) => bridge?.subscribe(listener) ?? (() => undefined),
    () => bridge?.getSnapshot() ?? null
  );
}

/**
 * 留一个格子给壳画它自己的组件(聊天渠道、设备授权页、云电脑设置……,见 AssistantShellHost)。
 * 格子挂上就登记,摘掉就注销;格子里的东西归壳的那棵树管,这一侧 ❌ 往里放子元素。
 */
export function ShellSlot({ name, className }: { name: AssistantShellSlot; className?: string }) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(assistantSlotKey(name), element),
    [name]
  );
  return <div ref={ref} className={className} data-assistant-slot={name} />;
}
