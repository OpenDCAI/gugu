import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { AgentAuthContext } from './auth';

/**
 * 「这家 harness 在这台电脑上，用户自己登的是谁的钱、什么套餐、这一期还剩多少」(product spec)。
 *
 * 套餐与用量能不能读到，取决于厂商**怎么卖订阅**:做成「登一个账号」的(Claude / ChatGPT / Google / GitHub),
 * 档位跟着账号走、本机读得到;做成「发一把 key」的(百炼 / 小米 / OpenCode),key 上不带档位，余量只在厂商
 * 网页后台;Pi / Hermes 本身不收钱，答案取决于背后接的那家。各家读法写在各自的插件里，出处随代码注释。
 *
 * ⚠️ 读这一格**绝不**触发登录:没登录就答 `not-signed-in`,❌ 起一个会弹登录页的命令去问。
 * ⚠️ 读不到就说读不到(`unknown` / `unavailable`),❌ 猜一个档位、❌ 把读不到画成 0。
 */

/** 用户自己的这份登录由谁付钱。咕咕积分不在这里 —— 那是会话层的选择，不是这家 harness 的登录。 */
export const subscriptionPayerSchema = z.enum([
  /** 用户在厂商那里买的订阅(套餐跟着账号或 key 走)。 */
  'subscription',
  /** 用户自己的按量计费 key。 */
  'api-key',
  /** 指到了厂商以外的服务(中转、自建网关):用量由那个服务记。 */
  'custom-endpoint',
  /** 没登用户自己的账号。 */
  'not-signed-in',
  /** 判不出。 */
  'unknown',
]);
export type SubscriptionPayer = z.infer<typeof subscriptionPayerSchema>;

export const subscriptionPlanReadingSchema = z.object({
  payer: subscriptionPayerSchema,
  /** 厂商自己卖的名字(「Claude Max 20x」「ChatGPT Pro 200」「Google AI Pro」)。档位读不出时只写到家族。 */
  plan: z.string().optional(),
  /** `plan` 只到家族(「百炼 Coding Plan」),具体档位读不出。 */
  tierUnknown: z.boolean().optional(),
  /** `custom-endpoint` 时那个服务的地址(只给主机名，❌ 带凭据)。 */
  endpoint: z.string().optional(),
  /** 本身不收钱、背后接别家的 harness(Pi / Hermes / OpenCode):这份登录接的是哪几家。 */
  via: z.array(z.string()).optional(),
  /** 套餐信息是厂商自家工具在什么时候记下的(epoch ms)—— 读的是缓存时如实说它多旧。 */
  planAsOf: z.number().optional(),
  /** 用 Claude 订阅登 Pi 这类:扣的是厂商的「额外用量」(另外计费),不占套餐额度。 */
  extraUsage: z.boolean().optional(),
  /** 判不出时的原因(给人看的一句)。 */
  message: z.string().optional(),
});
export type SubscriptionPlanReading = z.infer<typeof subscriptionPlanReadingSchema>;

/** 一个额度窗口。百分比一律 0–100 的「已用」;厂商只给剩余比例的，换算成已用。 */
export const subscriptionUsageWindowSchema = z.object({
  /** 厂商自己的分组名(「Gemini Models」「Fable」「premium_interactions」),没有分组时缺席。 */
  group: z.string().optional(),
  /** 窗口长度(分钟):300 = 5 小时,10080 = 每周。按月重置的写 `monthly`。 */
  windowMinutes: z.number().optional(),
  monthly: z.boolean().optional(),
  usedPercent: z.number(),
  /** 重置时刻(epoch ms)。 */
  resetsAt: z.number().optional(),
  /** 厂商给了绝对数时(Copilot 的次数):已用 / 总额。 */
  used: z.number().optional(),
  limit: z.number().optional(),
});
export type SubscriptionUsageWindow = z.infer<typeof subscriptionUsageWindowSchema>;

export const subscriptionUsageUnavailableReasonSchema = z.enum([
  /** 只在厂商网页后台看得到。 */
  'vendor-console',
  /** 厂商工具不报这件事。 */
  'not-reported',
  'not-signed-in',
  /** 接的是别的服务，用量由那边记。 */
  'custom-endpoint',
  /** 这家 harness 用的是另一份登录，咕咕读它会弹授权框。 */
  'other-login',
  /** 只在用户点「现在查」时才问的那几家，还没问过。 */
  'not-read-yet',
  /** 问了，失败了(`message` 说为什么)。 */
  'error',
]);
export type SubscriptionUsageUnavailableReason = z.infer<typeof subscriptionUsageUnavailableReasonSchema>;

export const subscriptionUsageReadingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('windows'),
    windows: z.array(subscriptionUsageWindowSchema).min(1),
    /** 这份读数是什么时候拿到的(epoch ms)。 */
    readAt: z.number(),
    /** A refresh failed; these remain the last successful figures, with their original readAt. */
    refreshError: z.string().optional(),
    /** 这家只在用户点「现在查」时才问(宿主按能力声明标上;界面据此给那一行「现在查」)。 */
    onDemand: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: subscriptionUsageUnavailableReasonSchema,
    /** 去厂商后台看的地址。 */
    consoleUrl: z.string().optional(),
    message: z.string().optional(),
    readAt: z.number(),
    onDemand: z.boolean().optional(),
  }),
]);
export type SubscriptionUsageReading = z.infer<typeof subscriptionUsageReadingSchema>;

export type ISubscriptionBehavior = {
  /** 谁付钱 + 套餐。只读本机(文件 / 不联网的 CLI 子命令),要快。 */
  readPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading>;
  /** 这一期还剩多少。可以联网、可以起这家自己的程序去问;拿到 `readPlan` 的结果，据此决定问不问。 */
  readUsage(ctx: AgentAuthContext, plan: SubscriptionPlanReading): Promise<SubscriptionUsageReading>;
};

/**
 * @param usageRefresh 'on-open'   - 打开「订阅」页就问一次(厂商的查询便宜、没有封禁风险)。
 *                     'on-demand' - 只在用户点「现在查」时问(Claude:厂商那个查询问几次就会被封一阵)。
 * @param program      读数要跑的伴随程序(Antigravity 的用量只有终端版 `agy` 报)。缺席 = 主程序。
 */
export const subscriptionCapability = definePluginCapability<ISubscriptionBehavior>()(
  'subscription',
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({
      kind: z.literal('supported'),
      usageRefresh: z.enum(['on-open', 'on-demand']),
      program: z.string().optional(),
    }),
  ]),
  { kind: 'none' },
  { requiresBehavior: (descriptor) => descriptor.kind === 'supported' }
);
