import { quotaSpendWindows, type QuotaWindows, type SpendWindow } from './quotaWindows'

// 「还能不能花」的唯一判定。
//
// 积分分两种,过期语义不同(官方会员口径):
//   1. **周期额度** —— 会员档每个订阅周期给一次,本期未用完不结转;
//   2. **不过期积分** —— 加量包买来的、注册礼包/邀请返利送来的,不随周期清零。
// 两者是同一种东西,**数字直接相加**;**消耗顺序是先周期额度、后不过期积分** ——
// 用户不会因为买过加量包就浪费已付费的本期额度。
//
// ❌ 曾经写成 `min(余额, 周期余量)`:那把周期额度当成了「不过期积分的花费上限」,而不是
// 一个自己有钱的池子。后端也确实从没往周期额度里放过钱(bind_subscription 只写档位与到期日),
// 于是一个付了 max、这一期 350 积分一分未动的会员,账上可花的仍然只有注册礼包剩下的 0.14,
// 界面还照实写着「30 天内最多能花 0.14 积分」—— 三处口径完全自洽,而且全错。
// 相加之后这个形状不会再出现:周期额度只要还有,它自己就是钱。
//
// ❌ 也别再退回「两道闸取紧者」的说法。现在只有**一种**花不出去:两个池子都空了。
// 分别报「余额不足」或「窗口用完」会告诉一个额度充足的人去充值,而他根本不需要。

/** 只有一种花不出去 —— 两个池子都见底。 */
export type SpendBlockReason = 'exhausted'

export interface SpendingPower {
  /** 本期周期额度还剩多少。周期结束归零,不结转。 */
  periodCredits: number
  /** 不过期积分:加量包买来的 + 一次性赠送的。 */
  walletCredits: number
  /** 已发出、尚未结算的预留。从**合计**里扣一次,❌ 不在两个池子里各扣一遍。 */
  held: number
  /** 此刻真正花得出去的 = max(0, 周期额度余量 + 不过期积分 − 预留)。 */
  spendable: number
  /** 花不出去时是谁挡的;还能花时为 null。 */
  blockedBy: SpendBlockReason | null
  /**
   * 周期额度什么时候刷新。**两池皆空时它仍然是个真时刻** —— 周期额度确实会自己回来,
   * 所以这里给时间戳不是骗人;同时充值加量包可以立刻恢复,文案两条都要说。
   */
  recoversAt: Date | null
  period: SpendWindow
}

/**
 * 低余额预警阈值(积分)。
 *
 * ⚠️ 这个数与**积分刻度**绑死。1 积分 = $1 牌价用量之后:
 *   · 旧值 200 是 $200 的量,比 max 档整个周期(350)还接近一半 —— 人人常年低余额;
 *   · 改过一版 5,同样常亮,只是错得更隐蔽:注册礼包**就是** 5,所以免费用户的余额终身在
 *     (0, 5] 区间里单调下降 —— 从第一次消费起横幅再没灭过。
 * 取 1:大约「还剩一美元」。量级上撑得住一两次真实调用(实测单次 0.09~1.14 积分),
 * 又远低于礼包,免费用户只在最后一段看见它。
 *
 * 「余额低到该提醒充值」是计费领域的判断,不是某个横幅的私有常量 —— 放这里,谁提醒都用同一条线。
 */
export const LOW_BALANCE_CREDITS = 1

/**
 * 快见底了,但还没耗尽。
 *
 * ⚠️ 传进来的必须是**能花的合计**(`SpendingPower.spendable`),不是不过期积分那一个池子。
 * 只看不过期积分的话,一个周期额度还剩 345 的 max 会员会被弹「积分不足(剩 0.14)」——
 * 线上真实发生过,而他一分钱都不缺。
 *
 * 恰好为 0 不算:那是已经被服务端挡住的耗尽态,由发起时的报错负责说,不该再弹一条
 * 「建议充值以免被中断」—— 已经中断了。
 */
export function isLowBalance(spendable: number): boolean {
  return spendable > 0 && spendable < LOW_BALANCE_CREDITS
}

export function deriveSpendingPower(
  balance: number,
  windows: QuotaWindows,
): SpendingPower {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new Error(`积分余额不可用：${String(balance)} 不是有效数值`)
  }
  const { period } = quotaSpendWindows(windows)
  const held = windows.outstanding_credits
  // 池子本身不减预留 —— 减在合计上,一次。period.remaining 已经替进度条扣过一遍,
  // 拿它来加会把同一笔在途用量算作两次占用。
  const periodCredits = Math.max(0, period.limit - period.used)
  const walletCredits = Math.max(0, balance)
  const spendable = Math.max(0, periodCredits + walletCredits - Math.max(0, held))

  if (spendable > 0) {
    return {
      periodCredits, walletCredits, held,
      spendable, blockedBy: null, recoversAt: null, period,
    }
  }
  // 两个池子都空了才算挡住。周期额度会在 freesAt 自己回来,充值加量包则立刻可用 ——
  // 两条出路都成立,文案里一起说,❌ 别挑一条当唯一答案。
  return {
    periodCredits, walletCredits, held,
    spendable: 0,
    blockedBy: 'exhausted',
    recoversAt: period.freesAt,
    period,
  }
}
