/**
 * 提示条的档位语义 —— 主 app 与会话页共用**同一张表**。
 *
 * 这个文件存在的理由是 #4891 查出来的病:两个界面各有一套 toast,主 app 四档
 * (success/error/warning/info),会话页只有两档(default/destructive),124 处调用只能二选一。
 * 病根不是会话页少写了两个分支,是**档位规则被手抄了两份**。抄一次就会漂一次,
 * 所以规则只留一份,两边都从这里读。
 */

export type ToastTier = 'success' | 'error' | 'warning' | 'info'

/**
 * 停留时长按「读完它要多久」分档,❌ 不是按类型好看分档。
 *
 * 成功/提示是一句确认,瞥一眼就够;失败要读、常常还要决定下一步,3s 读不完
 * (#4891 审计实测:错误文案 3s 自动消失且不可选中,用户既读不完也复制不了)。
 * 告警是「做成了但有残留」,介于两者之间。
 */
export const TOAST_DWELL_MS: Record<ToastTier, number> = {
  success: 3000,
  info: 3000,
  warning: 5000,
  error: 6000,
}

/**
 * 需要读、可能要复制的那两档:文字可选中、给关闭钮。
 *
 * 停留翻倍之后「不可关闭」比「短暂遮挡」更难受,所以可读的那两档必须能被当场关掉。
 */
export function isReadableTier(tier: ToastTier): boolean {
  return tier === 'error' || tier === 'warning'
}
