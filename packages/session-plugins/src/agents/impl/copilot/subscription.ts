import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';
import {
  clampPercent,
  errorMessage,
  finiteNumber,
  usageUnavailable,
  usageWindows,
} from '../../helpers/subscription';
import { isRecord } from '../../helpers/subscription-keyed';

/**
 * GitHub Copilot 的「订阅」读数(product spec)。
 *
 * 套餐与本月额度都在 GitHub 的 `GET /copilot_internal/user`(没有公开文档;Copilot CLI 自己也读它 ——
 * @github/copilot 1.0.88 `copilot-sdk/generated/rpc.d.ts:4075-4168` 把它的响应原样转出、标着实验性)。
 * 字段(10-13 本机 `gh api` 实测):`copilot_plan`(individual / business / enterprise)、
 * `access_type_sku`(Free 是 `free_limited_copilot`)、`quota_reset_date_utc`、
 * `quota_snapshots.{chat,completions,premium_interactions}.{entitlement,remaining,percent_remaining,unlimited}`。
 * owner 2026-10-13 定「加 Copilot」:打开「订阅」页时问一次。
 *
 * 用哪把令牌：交给 `gh api`(gh 自己的登录),❌ 咕咕自己碰令牌、❌ 把令牌写进 argv。
 * Copilot CLI 选令牌的先后是 COPILOT_GITHUB_TOKEN → GH_TOKEN → GITHUB_TOKEN → 它自己 `/login` 存的
 * (macOS 钥匙串 `copilot-cli`)→ gh 的登录(https://docs.github.com/en/copilot/how-tos/copilot-cli/
 * set-up-copilot-cli/authenticate-copilot-cli)。只有 gh 问到的**就是** Copilot 用的那个账号时才读;
 * 否则答 `other-login` —— 读另一个账号的额度比读不到更糟。钥匙串只看那一项**在不在**(不带 `-w`,不弹窗)。
 *
 * 套餐名：`free_limited_copilot` = Copilot Free;Business / Enterprise 按 sku / plan 认;
 * Pro / Pro+ / Max 的 sku 值没有一手样本 ⇒ 只写「Copilot」并标档位读不出，❌ 猜。
 */
const GH_TIMEOUT_MS = 15_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_NOT_FOUND = 44;

type CopilotUser = Record<string, unknown>;
type Fetched = { kind: 'ok'; user: CopilotUser } | { kind: 'other-login'; message: string } | { kind: 'error'; message: string };

/**
 * 宿主读用量时先读套餐、再读用量 —— 两次都要这一份响应。短时间内复用同一份，❌ 一次读数打两遍 GitHub。
 */
let recent: { at: number; result: Promise<Fetched> } | null = null;
const REUSE_MS = 10_000;

function sameToken(ctx: AgentAuthContext, name: string): boolean {
  // `gh` 跑在本进程的环境里(宿主的 exec 不带 ctx.env);只有两边这把令牌一致时，gh 看到的才是 Copilot 用的那把。
  return (ctx.env?.[name]?.trim() ?? '') === (process.env[name]?.trim() ?? '');
}

/** Copilot 自己 `/login` 存的那一项在不在。判不出(`security` 跑挂了)就说判不出，❌ 当成不在。 */
async function copilotOwnLogin(ctx: AgentAuthContext): Promise<'present' | 'absent' | 'unknown'> {
  if (process.platform !== 'darwin') return 'absent'; // UNVERIFIED:Linux / Windows 上它把 /login 存在哪没有一手读数。
  try {
    await ctx.exec('security', ['find-generic-password', '-s', 'copilot-cli'], { timeout: KEYCHAIN_TIMEOUT_MS });
    return 'present';
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === KEYCHAIN_NOT_FOUND ? 'absent' : 'unknown';
  }
}

async function fetchUncached(ctx: AgentAuthContext): Promise<Fetched> {
  if (ctx.env?.COPILOT_GITHUB_TOKEN?.trim()) {
    return { kind: 'other-login', message: 'Copilot 用的是 COPILOT_GITHUB_TOKEN 那把令牌，gh 问到的不一定是同一个账号。' };
  }
  if (!sameToken(ctx, 'GH_TOKEN') || !sameToken(ctx, 'GITHUB_TOKEN')) {
    return { kind: 'other-login', message: 'Copilot 与 gh 用的 GitHub 令牌不是同一把。' };
  }
  const tokenFromEnv = Boolean(ctx.env?.GH_TOKEN?.trim() || ctx.env?.GITHUB_TOKEN?.trim());
  if (!tokenFromEnv) {
    const own = await copilotOwnLogin(ctx);
    if (own === 'present') {
      return { kind: 'other-login', message: 'Copilot 用的是它自己 /login 存的登录;咕咕读它会弹钥匙串授权框。' };
    }
    if (own === 'unknown') return { kind: 'error', message: '判不出 Copilot 有没有自己的登录(钥匙串查询失败)。' };
  }
  try {
    const { stdout } = await ctx.exec('gh', ['api', '/copilot_internal/user'], { timeout: GH_TIMEOUT_MS });
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? { kind: 'ok', user: parsed } : { kind: 'error', message: 'GitHub 的回答不是一个对象。' };
  } catch (error) {
    return { kind: 'error', message: `gh api /copilot_internal/user 失败：${errorMessage(error)}` };
  }
}

function fetchCopilotUser(ctx: AgentAuthContext): Promise<Fetched> {
  const now = Date.now();
  if (recent && now - recent.at < REUSE_MS) return recent.result;
  const result = fetchUncached(ctx);
  recent = { at: now, result };
  return result;
}

/** 测试用：清掉复用的那一份。 */
export function resetCopilotSubscriptionCache(): void {
  recent = null;
}

export function copilotPlanName(user: CopilotUser): { plan: string; tierUnknown?: true } {
  const sku = typeof user.access_type_sku === 'string' ? user.access_type_sku.toLowerCase() : '';
  const plan = typeof user.copilot_plan === 'string' ? user.copilot_plan.toLowerCase() : '';
  if (sku === 'free_limited_copilot') return { plan: 'Copilot Free' };
  if (sku.includes('enterprise') || plan === 'enterprise') return { plan: 'Copilot Enterprise' };
  if (sku.includes('business') || plan === 'business') return { plan: 'Copilot Business' };
  return { plan: 'Copilot', tierUnknown: true };
}

export function copilotUsageWindows(user: CopilotUser): SubscriptionUsageWindow[] {
  const snapshots = isRecord(user.quota_snapshots) ? user.quota_snapshots : {};
  const resetRaw = user.quota_reset_date_utc ?? user.quota_reset_date;
  const resetsAt = typeof resetRaw === 'string' ? Date.parse(resetRaw) : NaN;
  const windows: SubscriptionUsageWindow[] = [];
  for (const [group, snapshot] of Object.entries(snapshots)) {
    if (!isRecord(snapshot) || snapshot.unlimited === true) continue;
    const limit = finiteNumber(snapshot.entitlement);
    if (limit === undefined || limit <= 0) continue;
    const remaining = finiteNumber(snapshot.remaining) ?? finiteNumber(snapshot.quota_remaining);
    const percentRemaining = finiteNumber(snapshot.percent_remaining);
    const usedPercent =
      percentRemaining !== undefined
        ? clampPercent(100 - percentRemaining)
        : remaining !== undefined
          ? clampPercent(((limit - remaining) / limit) * 100)
          : undefined;
    if (usedPercent === undefined) continue;
    windows.push({
      group,
      monthly: true,
      usedPercent,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      ...(remaining !== undefined ? { used: Math.max(0, limit - remaining), limit } : {}),
    });
  }
  return windows;
}

export async function readCopilotPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  // 套餐只在那份网络响应里，没有本地来源 ⇒ 读套餐也要问一次(与读用量共用同一份)。
  const fetched = await fetchCopilotUser(ctx);
  if (fetched.kind !== 'ok') return { payer: 'unknown', message: fetched.message };
  return { payer: 'subscription', ...copilotPlanName(fetched.user) };
}

export async function readCopilotUsage(ctx: AgentAuthContext, plan: SubscriptionPlanReading): Promise<SubscriptionUsageReading> {
  if (plan.payer !== 'subscription') {
    const fetched = await fetchCopilotUser(ctx);
    if (fetched.kind === 'other-login') return usageUnavailable('other-login', { message: fetched.message });
    return usageUnavailable('error', { message: plan.message });
  }
  const fetched = await fetchCopilotUser(ctx);
  if (fetched.kind === 'other-login') return usageUnavailable('other-login', { message: fetched.message });
  if (fetched.kind === 'error') return usageUnavailable('error', { message: fetched.message });
  const windows = copilotUsageWindows(fetched.user);
  if (windows.length === 0) return usageUnavailable('not-reported', { message: '这一档的额度不设上限。' });
  return usageWindows(windows);
}

export const copilotSubscription: ISubscriptionBehavior = {
  readPlan: readCopilotPlan,
  readUsage: readCopilotUsage,
};
