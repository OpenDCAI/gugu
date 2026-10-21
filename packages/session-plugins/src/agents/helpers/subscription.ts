import type {
  AgentAuthContext,
  SubscriptionUsageReading,
  SubscriptionUsageUnavailableReason,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';

/**
 * 各家「订阅」读数(product spec)共用的几样小工具。读法本身在各家插件里 —— 每家的出处不同。
 */

export function usageUnavailable(
  reason: SubscriptionUsageUnavailableReason,
  extra: { consoleUrl?: string; message?: string } = {}
): SubscriptionUsageReading {
  return { kind: 'unavailable', reason, ...extra, readAt: Date.now() };
}

export function usageWindows(windows: SubscriptionUsageWindow[]): SubscriptionUsageReading {
  if (windows.length === 0) return usageUnavailable('error', { message: '厂商答了，但里面一个额度窗口都没有。' });
  return { kind: 'windows', windows, readAt: Date.now() };
}

/** 读一份 JSON;不存在 / 解析不了 ⇒ null(调用方据此答「判不出」,❌ 当成「没有」)。 */
export async function readJsonObject(ctx: Pick<AgentAuthContext, 'fs'>, path: string): Promise<Record<string, unknown> | null> {
  const raw = await ctx.fs.read(path).catch(() => null);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 只解 JWT 的载荷段(本地 base64,不验签、不联网);解不出 ⇒ null。 */
export function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 服务地址只给主机名(含端口)—— ❌ 把路径、查询串里可能夹带的东西带到界面上。 */
export function endpointHost(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    return new URL(url.trim()).host || undefined;
  } catch {
    return undefined;
  }
}

export function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inner = (value as Record<string, unknown>)[key];
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const { stderr, message } = error as { stderr?: unknown; message?: unknown };
    const text = [stderr, message].find((part) => typeof part === 'string' && part.trim());
    if (typeof text === 'string') return text.trim().split('\n')[0]!.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/**
 * ChatGPT 登录令牌里 `https://api.openai.com/auth`.`chatgpt_plan_type` → 厂商自己显示的名字。
 * 对照表取自 Codex 自己的状态页(openai/codex `codex-rs/tui/src/subscription.rs:11-36`,rust-v0.160.0):
 * ⚠️ `pro` 是 Pro 200、`prolite` 是 Pro 100、`promax` 是 Pro 500;`business` 在 Codex 里显示成 Enterprise,
 *    `team` 才是 Business —— 照它，❌ 按字面猜。表外的值 ⇒ undefined(界面写「档位读不出」)。
 */
const CHATGPT_PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro 200',
  prolite: 'Pro 100',
  promax: 'Pro 500',
  team: 'Business',
  self_serve_business_usage_based: 'Business',
  self_serve_business_prolite: 'Business Premium',
  business: 'Enterprise',
  enterprise: 'Enterprise',
  ent26: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  hc: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise (Automation)',
  edu: 'Edu',
  education: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
};

export function chatgptPlanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = CHATGPT_PLAN_NAMES[raw.trim().toLowerCase()];
  return name ? `ChatGPT ${name}` : undefined;
}

/** 解一枚 ChatGPT 登录令牌(id_token 或 access_token)里的 `chatgpt_plan_type`。 */
export function chatgptPlanTypeOf(token: unknown): string | undefined {
  const auth = objectAt(jwtPayload(token), 'https://api.openai.com/auth');
  const raw = auth?.chatgpt_plan_type;
  return typeof raw === 'string' ? raw : undefined;
}
