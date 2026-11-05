// 余额面:积分账户本身的进出 —— 读余额。
// @@@3189 余额 = 不过期积分(加量包买来的 + 注册礼包/邀请返利送来的)。换算率由服务端
// billing.pricing_settings 定,下单见 purchase.ts;客户端不持有任何换算常量。
// 读取走 RLS(owner-select 只见自己行)。无 billing 后端时(未部署 edge fn / 未配密钥)调用会
// 报错 → 调用方显式提示,不静默。
import { activeCreditV2, creditV2, creditV2Read } from './v2/runtime'
import { CreditV2StateError } from './v2/active'

// Read the projected JSON-number balance for display. Missing rows remain unknown; RLS is authoritative.
export async function getCreditsBalance(): Promise<number> {
  return creditV2Read(async () => {
    const balance = await activeCreditV2.table(() => creditV2.balance())
    if (balance === null) throw new CreditV2StateError('unknown')
    return balance
  })
}
