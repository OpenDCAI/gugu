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
 * Pi 的「订阅」读数(product spec)。
 *
 * Pi 本身免费，订阅属于它背后接的厂商。用户 `/login` 的凭据在 `~/.pi/agent/auth.json`
 * (`PI_CODING_AGENT_DIR` 会把它挪走 —— 见 ./agent-dir.ts 的 `piAgentDir`):
 * 键 = provider,条目 `{type:'oauth', refresh, access, expires, accountId?}` 或 `{type:'api_key', key}`
 * (@earendil-works/pi-coding-agent 0.84.2 `docs/providers.md`「Auth File」节;OAuth 条目形状见
 * `pi-ai/dist/auth/oauth/anthropic.js:181-185`、`openai-codex.js:320-337`)。
 *  · 订阅登录(OAuth):anthropic(Claude Pro/Max)、openai-codex(ChatGPT)、github-copilot、xai、kimi-coding、radius。
 *  · openrouter 的 OAuth 只是替你铸一把从 OpenRouter 余额扣钱的 key ⇒ 算按量。
 * ⚠️ 用 Claude 订阅登 Pi,扣的是 Claude 的「额外用量」(另外按 token 计费),**不占**套餐额度 ——
 *    `docs/providers.md:35` 原话「Third-party harness usage draws from extra usage and is billed per token,
 *    not against Claude plan limits」⇒ `extraUsage: true`,界面要说出来。
 * 用量:Pi 不报任何套餐余量(RPC 只有本会话的 token / cost)⇒ `not-reported`。
 */
const AUTH_PATH = '.pi/agent/auth.json';
const RELOCATION_VARS = ['PI_CODING_AGENT_DIR'];

/** 订阅类 provider,按「给哪一家写套餐名」的先后排。 */
const SUBSCRIPTION_PROVIDERS = ['openai-codex', 'anthropic', 'github-copilot', 'xai', 'kimi-coding', 'radius'];
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  'github-copilot': 'GitHub Copilot',
  xai: 'xAI',
  'kimi-coding': 'Kimi',
  radius: 'Radius',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  google: 'Google Gemini',
};
/** `docs/providers.md`「Environment Variables or Auth File」表里最常见的几把(auth.json 优先于环境变量)。 */
const API_KEY_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GEMINI_API_KEY: 'google',
  OPENROUTER_API_KEY: 'openrouter',
};

const nameOf = (id: string) => PROVIDER_NAMES[id] ?? id;

export async function readPiPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const relocated = relocatedAway(ctx, RELOCATION_VARS);
  if (relocated) return relocatedReading(relocated);

  const auth = await readJsonFile(ctx, AUTH_PATH);
  if (auth.kind === 'unreadable') return unreadableReading(AUTH_PATH);
  const entries = auth.kind === 'ok'
    ? Object.entries(auth.value).filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]))
    : [];

  const subscriptions = SUBSCRIPTION_PROVIDERS.filter((id) =>
    entries.some(([key, entry]) => key === id && entry.type === 'oauth')
  );
  if (subscriptions.length > 0) {
    const via = entries.map(([id]) => nameOf(id));
    const first = subscriptions[0]!;
    const entry = entries.find(([id]) => id === first)![1];
    const plan = first === 'openai-codex' ? chatgptPlanName(chatgptPlanTypeOf(entry.access)) : undefined;
    return {
      payer: 'subscription',
      plan: plan ?? nameOf(first),
      ...(plan ? {} : { tierUnknown: true }),
      via,
      ...(subscriptions.includes('anthropic') ? { extraUsage: true } : {}),
    };
  }
  if (entries.length > 0) return { payer: 'api-key', via: entries.map(([id]) => nameOf(id)) };

  const fromEnv = Object.entries(API_KEY_ENV)
    .filter(([name]) => Boolean(ctx.env?.[name]?.trim()))
    .map(([, id]) => nameOf(id));
  if (fromEnv.length > 0) return { payer: 'api-key', via: fromEnv };
  return { payer: 'not-signed-in' };
}

export async function readPiUsage(_ctx: AgentAuthContext, plan: SubscriptionPlanReading): Promise<SubscriptionUsageReading> {
  if (plan.payer === 'not-signed-in') return usageUnavailable('not-signed-in');
  if (plan.payer === 'unknown') return usageUnavailable('error', { message: plan.message });
  return usageUnavailable('not-reported');
}

export const piSubscription: ISubscriptionBehavior = {
  readPlan: readPiPlan,
  readUsage: readPiUsage,
};
