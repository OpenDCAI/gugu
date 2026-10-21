import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import { TOAST_DWELL_MS, isReadableTier, type ToastTier } from '../../../../lib/toastTiers';

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  title?: string;
  description?: ReactNode;
  /**
   * 档位与主 app 同一套(#4891)。以前这里只有 `default | destructive` 两档,
   * 「做成了但有残留」和「彻底失败」被迫共用同一个红,而 sonner 本来就有四档 ——
   * 是这层包装把它收窄了,不是底层不支持。
   */
  tier?: ToastTier;
  /** @deprecated 用 `tier`。留着是为了不把 124 处调用堵在一个 PR 里,迁完即删。 */
  variant?: 'default' | 'destructive';
  action?: ToastAction;
  icon?: ReactNode;
  /** 带一次性动作(撤销)的提示要留够点它的时间;不给就是 sonner 的默认停留。 */
  duration?: number;
};

const SONNER_BY_TIER = {
  success: sonnerToast.success,
  error: sonnerToast.error,
  warning: sonnerToast.warning,
  info: sonnerToast.info,
} as const;

function toast({ title, description, tier, variant, action, icon, duration }: Toast) {
  const options = {
    description,
    icon,
    ...(action && { action: { label: action.label, onClick: action.onClick } }),
    ...(duration !== undefined && { duration }),
  };

  // ❌ 没显式给档位的调用**行为一字不变**。把 124 处未迁调用一次性改成 info 样式 + 3s 停留,
  // 是一次没人审过的外观变更;分类要在按域迁移的那几个 PR 里逐条被看见。
  if (!tier) {
    if (variant === 'destructive') return sonnerToast.error(title, options);
    return sonnerToast(title ?? '', options);
  }

  return SONNER_BY_TIER[tier](title ?? '', {
    ...options,
    duration: TOAST_DWELL_MS[tier],
    // 要读要复制的那两档必须能当场关掉 —— 停留翻倍之后,「不可关闭」比「短暂遮挡」更难受。
    closeButton: isReadableTier(tier),
  });
}

function useToast() {
  return { toast };
}

export { toast, useToast };
