// 加量包的快捷金额与积分换算。
//
// 单独成文件而不是放在 TopupPicker.tsx 里:组件文件导出非组件会破坏 Fast Refresh
// (eslint react-refresh/only-export-components,CI 的 lint 是 --max-warnings 0)。
// 分出来也更顺 —— 守卫单测要的是这两个导出,不是那个组件。

/**
 * 快捷金额(元)。只是入口,不是价格 —— 每档对应多少积分由换算率现算。
 * owner 2026-08-24 拍板这三档;同时删掉 ¥6(「没必要太低了」)。
 *
 * ⚠️ 「改换算率不用改这里」是错的。上一版四个数(6/30/100/298)是按 ¥1 = 10 积分挑的(#3203),
 * 刻度落到 0.3 之后 ¥6 × 0.3 = 1.8 被向下取整砍成 1 积分 —— 单价 ¥6/积分,比其他档贵 80%,
 * 而档位并排摆着像是平等选项。
 *
 * **换算率 0.3 下只有 10 的倍数才整除,而 .9 结尾的心理定价永远不是**
 * (29.9 × 0.3 = 8.97、99.9 × 0.3 = 29.97)。所以取整用 round 而不是 floor,
 * 偏差压到 ±0.5 积分以内且方向对用户有利,金额从此不必迁就换算率。
 *
 * 加档前先看 topupAmountsScale 单测 —— 它守着「到账不为 0」和「相对偏差 ≤ 5%」。
 */
export const AMOUNTS_CNY = [29.9, 99.9, 299] as const

/**
 * 面板打开时预选哪一档。
 *
 * ⚠️ 从清单**派生**,❌ 不要写成字面量。上一版就是字面量 `useState<number>(30)` —— 清单从
 * [6, 30, 100, 298] 换成现在这三档时它没跟着改,于是面板打开时三个按钮一个都不高亮
 * (aria-checked 全 false),支付按钮却写着「支付 ¥30」,点下去创建一笔清单里根本没有的
 * ¥30 订单。换清单不换默认值这一类,派生一次就永久免疫。
 */
export const DEFAULT_AMOUNT_CNY: number = AMOUNTS_CNY[0]

/**
 * 这笔钱到账多少积分。
 *
 * 积分数不能带小数:`payment_orders.credited_credits` 是 bigint。所以取整去不掉,
 * 只能选一种取整方式并让金额配得上它。
 *
 * ⚠️ 服务端 gugu-supabase 的 `supabase/functions/pay-create` 有一份独立实现(Deno 边界,共享不了代码),
 * **两处必须是同一个式子**:展示倍率恒等于结算倍率(官方计价口径),两边取整方式
 * 不同就是欺骗,即便偏差方向对平台不利也一样。两边一致由 tests/contract/supabase/topupCredits.test.ts 判(两个仓的 CI 都跑)。
 */
export const creditsForAmount = (amountCny: number, creditsPerCny: number): number =>
  Math.round(amountCny * creditsPerCny)
