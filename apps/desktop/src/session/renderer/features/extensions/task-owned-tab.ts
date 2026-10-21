import { parseExtensionTabKind } from '@shared/extensions/manifest';

/**
 * #7317 一个任务一份的 App 页签(manifest `perSession`,标在页签自己的状态上:App 清单还没到也认得)。
 * 它是那个任务自己的页,只在那个任务里显示 ⇒ ❌ 成块挪去别处、❌ 单独成窗(窗里没有它那一页,只会是一片空白)。
 */
export function isTaskOwnedTab(entry: { kind: string; state?: unknown }): boolean {
  return parseExtensionTabKind(entry.kind) !== null && (entry.state as { perSession?: unknown } | undefined)?.perSession === true;
}
