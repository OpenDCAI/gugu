import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';
import {
  endpointHost,
  errorMessage,
  objectAt,
  readJsonObject,
  usageUnavailable,
  usageWindows,
  finiteNumber,
  clampPercent,
} from '../../helpers/subscription';
import { requestSubscriptionJson } from '../../helpers/subscription-http';
import { readClaudeAccessToken } from './credentials';

/**
 * Claude Code 的「订阅」读数(product spec)。
 *
 * 套餐:`claude auth status`(JSON)的 `authMethod` / `subscriptionType`,档位再看 `~/.claude.json` 的
 * `oauthAccount.organizationRateLimitTier` —— Claude Code 自己就是这么判 Max 5x / 20x 的
 * (2.1.296 二进制:`subscriptionType==="max" && rateLimitTier==="default_claude_max_20x"`;本机实测
 * `organizationType=claude_max`、`organizationRateLimitTier=default_claude_max_20x`)。
 * `.claude.json` 是 Claude Code 上次拉账号资料时写的，用户换档后要等它下次启动才更新 ⇒ 随读数给 `planAsOf`。
 *
 * 用量:参考 cockpit-tools claude_account_desktop_auth.rs，读取 OAuth usage JSON，
 * five_hour / seven_day / 模型分组直接映射成窗口。打开订阅页读取，无首次手动查询步骤。
 */

const AUTH_STATUS_TIMEOUT_MS = 5_000;
const CLAUDE_CONSOLE_USAGE = 'https://claude.ai/settings/usage';

type AuthStatus = Record<string, unknown>;

export function claudeSubscriptionBehavior(): ISubscriptionBehavior {
  return { readPlan: readClaudePlan, readUsage: readClaudeUsage };
}

export async function readClaudePlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const baseUrl = ctx.env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl) {
    // 指到了别的服务(中转 / 自建网关):不管登没登，推理都走那边。
    return { payer: 'custom-endpoint', endpoint: endpointHost(baseUrl) ?? baseUrl };
  }
  if (ctx.env.ANTHROPIC_API_KEY?.trim() || ctx.env.ANTHROPIC_AUTH_TOKEN?.trim()) return { payer: 'api-key' };

  let status: AuthStatus | null;
  try {
    const { stdout } = await ctx.exec(ctx.cli, ['auth', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS });
    status = parseObject(stdout);
  } catch (error) {
    // 没登录时 `auth status` 退出码 1,stdout 里照样是那份 JSON。
    status = parseObject((error as { stdout?: unknown } | null)?.stdout);
    if (!status) return { payer: 'unknown', message: errorMessage(error) };
  }
  if (!status) return { payer: 'unknown', message: 'claude auth status 没有给出能读的结果。' };
  return planFromAuthStatus(status, await readTier(ctx));
}

/** 纯函数:`auth status` + `.claude.json` 的那几格 → 读数。分出来是为了能拿真实形状的夹具测。 */
export function planFromAuthStatus(status: AuthStatus, tier: ClaudeTier | null): SubscriptionPlanReading {
  if (status.apiKeySource) return { payer: 'api-key' };
  switch (status.authMethod) {
    case 'claude.ai':
    case 'oauth_token': {
      const plan = claudePlanName(stringOf(status.subscriptionType), tier);
      return {
        payer: 'subscription',
        plan: plan.name,
        ...(plan.tierUnknown ? { tierUnknown: true } : {}),
        ...(tier?.asOf !== undefined && plan.fromTier ? { planAsOf: tier.asOf } : {}),
      };
    }
    case 'api_key':
    case 'api_key_helper':
      return { payer: 'api-key' };
    case 'third_party':
      // Bedrock / Vertex 等云:钱付给那家云。
      return { payer: 'custom-endpoint', endpoint: stringOf(status.apiProvider) ?? 'third-party' };
    case 'none':
      return { payer: 'not-signed-in' };
    default:
      return status.loggedIn === false ? { payer: 'not-signed-in' } : { payer: 'unknown' };
  }
}

export type ClaudeTier = { organizationType?: string; rateLimitTier?: string; asOf?: number };

/**
 * `subscriptionType` + 档位 → 厂商自己的名字。认不出的档位只写到家族(`tierUnknown`),❌ 猜。
 * Pro 的 `rateLimitTier` 字面没在二进制里搜到 ⇒ Pro 只按 `subscriptionType` 认。
 */
export function claudePlanName(
  subscriptionType: string | undefined,
  tier: ClaudeTier | null
): { name: string; tierUnknown?: true; fromTier?: true } {
  const type = subscriptionType ?? organizationTypeToSubscription(tier?.organizationType);
  switch (type) {
    case 'pro':
      return { name: 'Claude Pro' };
    case 'max':
      if (tier?.rateLimitTier === 'default_claude_max_20x') return { name: 'Claude Max 20x', fromTier: true };
      if (tier?.rateLimitTier === 'default_claude_max_5x') return { name: 'Claude Max 5x', fromTier: true };
      return { name: 'Claude Max', tierUnknown: true };
    case 'team':
      return { name: 'Claude Team' };
    case 'enterprise':
      return { name: 'Claude Enterprise' };
    default:
      return { name: 'Claude', tierUnknown: true };
  }
}

function organizationTypeToSubscription(type: string | undefined): string | undefined {
  return type?.startsWith('claude_') ? type.slice('claude_'.length) : undefined;
}

/** `.claude.json` 在 home 下;用户挪了 `CLAUDE_CONFIG_DIR` 而 fs 照不到那里 ⇒ 不读(只按 `subscriptionType` 认)。 */
async function readTier(ctx: AgentAuthContext): Promise<ClaudeTier | null> {
  if (ctx.env.CLAUDE_CONFIG_DIR?.trim() && !ctx.fsFollowsConfigRoot) return null;
  // Claude keeps this file inside an explicit CLAUDE_CONFIG_DIR (verified with 2.1.296).
  // The host's selected credential fs is home-shaped, with that directory at `.claude`.
  const path = ctx.env.CLAUDE_CONFIG_DIR?.trim() ? '.claude/.claude.json' : '.claude.json';
  const config = await readJsonObject(ctx, path);
  const account = objectAt(config, 'oauthAccount');
  if (!account) return null;
  const fetchedAt = account.profileFetchedAt;
  const asOf = typeof fetchedAt === 'number' ? fetchedAt : typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : NaN;
  return {
    organizationType: stringOf(account.organizationType),
    rateLimitTier: stringOf(account.organizationRateLimitTier) ?? stringOf(account.userRateLimitTier),
    ...(Number.isFinite(asOf) ? { asOf } : {}),
  };
}

export async function readClaudeUsage(
  ctx: AgentAuthContext,
  plan: SubscriptionPlanReading
): Promise<SubscriptionUsageReading> {
  if (plan.payer === 'not-signed-in') return usageUnavailable('not-signed-in');
  if (plan.payer === 'custom-endpoint') return usageUnavailable('custom-endpoint');
  if (plan.payer !== 'subscription') return usageUnavailable('not-reported');
  try {
    const token = await readClaudeAccessToken(ctx);
    if (!token) return usageUnavailable('error', { message: '没有可读取的 Claude 订阅凭据，请重新登录。' });
    const result = await requestSubscriptionJson(ctx, 'https://api.anthropic.com/api/oauth/usage', {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'gugu',
    });
    const windows = windowsFromClaudeUsage(result);
    if (windows.length === 0) {
      return usageUnavailable('error', { message: 'Claude 没有返回额度窗口。', consoleUrl: CLAUDE_CONSOLE_USAGE });
    }
    return usageWindows(windows);
  } catch (error) {
    return usageUnavailable('error', { message: errorMessage(error), consoleUrl: CLAUDE_CONSOLE_USAGE });
  }
}

/** Structured OAuth usage fields used by cockpit-tools request_usage / usage_to_quota. */
export function windowsFromClaudeUsage(raw: unknown): SubscriptionUsageWindow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const windows: SubscriptionUsageWindow[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'five_hour' && !key.startsWith('seven_day')) continue;
    const item = value as { utilization?: unknown; resets_at?: unknown } | null;
    const used = finiteNumber(item?.utilization);
    if (used === undefined) continue;
    const reset = typeof item?.resets_at === 'string' ? Date.parse(item.resets_at) : NaN;
    const group = key.startsWith('seven_day_') ? key.slice('seven_day_'.length) : undefined;
    windows.push({
      windowMinutes: key === 'five_hour' ? 300 : 10_080,
      usedPercent: clampPercent(used),
      ...(group ? { group } : {}),
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
    });
  }
  return windows;
}

/**
 * `/usage` 的正文 → 窗口。Claude Code 2.1.296 本机实测的样子:
 *   Current session: 18% used · resets Oct 13 at 6:59am (Asia/Shanghai)
 *   Current week (all models): 84% used · resets Oct 14 at 3:59am (Asia/Shanghai)
 *   Current week (Fable): 18% used · resets Oct 14 at 3:59am (Asia/Shanghai)
 * 「Current session」是 5 小时那个窗口;「Current week (X)」是每周、X 是它的分组。认不出的行跳过。
 */
export function parseClaudeUsageText(text: string, now: Date): SubscriptionUsageWindow[] {
  const windows: SubscriptionUsageWindow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(Current session|Current week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line);
    if (!match) continue;
    const [, label, group, percent, reset] = match;
    const resetsAt = reset ? parseResetTime(reset, now) : undefined;
    windows.push({
      ...(group ? { group } : {}),
      windowMinutes: label === 'Current session' ? 300 : 10_080,
      usedPercent: Math.min(100, Math.max(0, Number(percent))),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return windows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * 「Oct 13 at 6:59am (Asia/Shanghai)」/「6:59am (Asia/Shanghai)」→ epoch ms。
 * 墙上时间按括号里那个时区解;没年份 ⇒ 取离 now 最近的那一年(重置时刻不会在一周以前)。认不出 ⇒ undefined。
 */
export function parseResetTime(text: string, now: Date): number | undefined {
  const match = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?$/i.exec(text.trim());
  if (!match) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
  let hour = Number(hourText) % 12;
  if (meridiem!.toLowerCase() === 'pm') hour += 12;
  const minute = minuteText ? Number(minuteText) : 0;
  const zone = timeZone?.trim();
  const zoned = zone ? partsIn(now, zone) : null;
  if (zone && !zoned) return undefined;
  const today = zoned ?? { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : today.month;
  if (month < 0) return undefined;
  const day = dayText ? Number(dayText) : today.day;
  const toEpoch = (year: number) => wallTimeToEpoch(year, month, day, hour, minute, zone);
  let at = toEpoch(today.year);
  if (at === undefined) return undefined;
  if (at < now.getTime() - 7 * 24 * 3_600_000) at = toEpoch(today.year + 1) ?? at;
  return at;
}

function partsIn(date: Date, timeZone: string): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: get('year'), month: get('month') - 1, day: get('day') };
  } catch {
    return null;
  }
}

/** 某时区里的墙上时间 → epoch ms(不引库:先按 UTC 猜，再用那个时区当时的偏移修正一次)。 */
function wallTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | undefined
): number | undefined {
  const guess = Date.UTC(year, month, day, hour, minute);
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
  const offset = zoneOffsetMs(guess, timeZone);
  if (offset === undefined) return undefined;
  return guess - offset;
}

function zoneOffsetMs(at: number, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - at;
  } catch {
    return undefined;
  }
}

function parseObject(output: unknown): AuthStatus | null {
  if (typeof output !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AuthStatus) : null;
  } catch {
    return null;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
