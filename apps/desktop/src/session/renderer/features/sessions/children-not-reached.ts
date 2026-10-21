import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { ArchiveOutcome } from '@shared/core/sessions/sessions';

/**
 * 「连同子会话」跨机器(owner 2026-10-01「一起收」):这次够不着的机器上,由这棵树派过去的 child 原样留着 ——
 * 动作本身成了,所以不是失败提示,但要说出来是哪几台。归档与删除同一句。
 */
export function tellChildrenNotReached(unreached: ArchiveOutcome['unreached']): void {
  if (unreached.length === 0) return;
  const machines = unreached
    .map((machine) => machine.label ?? translateSessionMessage('task.anotherMachine'))
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .join(', ');
  toast({
    title: translateSessionMessage('task.childrenNotReached'),
    description: translateSessionMessage('task.childrenNotReachedHint', { machines }),
  });
}
