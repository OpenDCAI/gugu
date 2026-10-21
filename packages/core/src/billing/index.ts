// 计费领域层。积分是唯一货币(1 积分 = $1 牌价用量),额度窗口是这笔积分的花费上限
// —— 一个订阅周期一个池子,两件事的判定都只在这里。
// 这里没有 React、没有 supabase、没有取数:renderer 的 view-model 归 apps/desktop/src/lib/billing。
export {
  deriveSpendWindow,
  periodUsdFor,
  quotaSpendWindows,
  windowHours,
  type QuotaWindows,
  type SpendWindow,
} from './quotaWindows'
export {
  deriveSpendingPower,
  isLowBalance,
  LOW_BALANCE_CREDITS,
  type SpendBlockReason,
  type SpendingPower,
} from './spendingPower'
