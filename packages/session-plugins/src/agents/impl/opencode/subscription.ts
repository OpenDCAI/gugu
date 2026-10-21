import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import { chatgptPlanName, chatgptPlanTypeOf, usageUnavailable } from '../../helpers/subscription';
import {
  isRecord,
  readJsonFile,
  relocatedAway,
  relocatedReading,
  unreadableReading,
} from '../../helpers/subscription-keyed';

/**
 * OpenCode 的「订阅」读数(product spec)。
 *
 * 凭据按 provider 存在 `~/.local/share/opencode/auth.json`(键 = providerID;条目 `oauth{refresh, access,
 * expires, accountId?}` / `api{key}` / `wellknown{key, token}` —— anomalyco/opencode v1.18.28
 * `packages/opencode/src/auth/index.ts:10-34`)。
 *  · `opencode-go`:OpenCode Go 订阅 —— 本地只存 key,**Go 与 Go Plus 分不出**(tierUnknown)。
 *  · `openai` 且 `type: oauth`:ChatGPT 登录(`plugin/openai/codex.ts`),档位解 access 令牌的 `chatgpt_plan_type`。
 *  · `opencode`:Zen,按量付费。
 * 用量:Go 的余量只在 OpenCode 控制台 —— 官方文档原话「You can track your current usage in the console」,
 * 链接 https://opencode.ai/auth(https://opencode.ai/docs/go/ 「Usage limits」节,2026-10-13 取回)。
 * 有一个没写进文档的 `zen/go/v1/usage` 接口，生产返回形状未验证 ⇒ ❌ 不调(owner 定「加 Copilot」档)。
 *
 * ⚠️ `XDG_DATA_HOME` 会把数据根挪走(opencode 走 XDG 目录);设了而 fs 不随根走 ⇒ `unknown`。
 */
const AUTH_PATH = '.local/share/opencode/auth.json';
const RELOCATION_VARS = ['XDG_DATA_HOME'];
export const OPENCODE_CONSOLE_URL = 'https://opencode.ai/auth';

const PROVIDER_NAMES: Record<string, string> = {
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode Zen',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  google: 'Google',
};

export async function readOpencodePlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const relocated = relocatedAway(ctx, RELOCATION_VARS);
  if (relocated) return relocatedReading(relocated);

  const auth = await readJsonFile(ctx, AUTH_PATH);
  if (auth.kind === 'unreadable') return unreadableReading(AUTH_PATH);
  if (auth.kind === 'absent') return { payer: 'not-signed-in' };

  const entries = Object.entries(auth.value).filter(([, entry]) => isRecord(entry));
  if (entries.length === 0) return { payer: 'not-signed-in' };
  const via = entries.map(([id]) => PROVIDER_NAMES[id] ?? id);
  const has = (id: string) => Object.hasOwn(auth.value, id) && isRecord(auth.value[id]);

  if (has('opencode-go')) {
    return { payer: 'subscription', plan: 'OpenCode Go', tierUnknown: true, via };
  }
  const openai = auth.value.openai;
  if (isRecord(openai) && openai.type === 'oauth') {
    const plan = chatgptPlanName(chatgptPlanTypeOf(openai.access));
    return plan ? { payer: 'subscription', plan, via } : { payer: 'subscription', plan: 'ChatGPT', tierUnknown: true, via };
  }
  if (has('opencode')) return { payer: 'api-key', plan: 'OpenCode Zen', via };
  return { payer: 'api-key', via };
}

export async function readOpencodeUsage(
  _ctx: AgentAuthContext,
  plan: SubscriptionPlanReading
): Promise<SubscriptionUsageReading> {
  if (plan.payer === 'not-signed-in') return usageUnavailable('not-signed-in');
  if (plan.payer === 'unknown') return usageUnavailable('error', { message: plan.message });
  if (plan.plan === 'OpenCode Go' || plan.plan === 'OpenCode Zen') {
    return usageUnavailable('vendor-console', { consoleUrl: OPENCODE_CONSOLE_URL });
  }
  // ChatGPT 登录：余量由 OpenAI 记;OpenCode 自己不报，咕咕也 ❌ 从这里去调 ChatGPT 的内部接口。
  return usageUnavailable('not-reported');
}

export const opencodeSubscription: ISubscriptionBehavior = {
  readPlan: readOpencodePlan,
  readUsage: readOpencodeUsage,
};
