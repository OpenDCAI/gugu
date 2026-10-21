import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import { endpointHost, usageUnavailable } from '../../helpers/subscription';
import {
  isRecord,
  readJsonFile,
  relocatedAway,
  relocatedReading,
  unreadableReading,
} from '../../helpers/subscription-keyed';

/**
 * MiMo Code(opencode 的逐字节 fork)的「订阅」读数(product spec)。
 *
 * 凭据在 `~/.local/share/mimocode/auth.json`(与 opencode 同形，见 ./auth.ts)。小米把订阅做成「发一把 key」:
 * **按 key 的前缀**分计费方式 —— `sk-` 按量付费、`tp-` Token Plan 个人版、`ttp-` Token Plan 团队版
 * (https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access);provider id 为
 * `xiaomi-token-plan-{cn,sgp,ams}` 的同样是 Token Plan(Pi 文档的 auth.json 键表也列着这三个)。
 * ⚠️ 浏览器登录拿到的也可能是 `sk-`(本机 10-13 实测)—— 所以按 key 判，❌ 按登录方式判。
 * ❌ 读数里带 key 本身:只取前缀做分类。
 *
 * 档位(Lite / Standard / Pro / Max)与余量只在小米开放平台网页后台(要小米账号的网页登录，咕咕没有)。
 * 控制台:https://platform.xiaomimimo.com/(官网首页「控制台 —— 管理 API key，查看用量」)。
 */
const AUTH_PATH = '.local/share/mimocode/auth.json';
const RELOCATION_VARS = ['MIMOCODE_HOME', 'XDG_DATA_HOME'];
export const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/';

type KeyClass = 'pay-as-you-go' | 'token-plan' | 'token-plan-team' | 'unknown';

function classifyKey(providerId: string, key: unknown): KeyClass {
  if (typeof key === 'string') {
    if (key.startsWith('ttp-')) return 'token-plan-team';
    if (key.startsWith('tp-')) return 'token-plan';
    if (key.startsWith('sk-')) return 'pay-as-you-go';
  }
  return providerId.startsWith('xiaomi-token-plan') ? 'token-plan' : 'unknown';
}

export async function readMimocodePlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const relocated = relocatedAway(ctx, RELOCATION_VARS);
  if (relocated) return relocatedReading(relocated);

  const auth = await readJsonFile(ctx, AUTH_PATH);
  if (auth.kind === 'unreadable') return unreadableReading(AUTH_PATH);
  if (auth.kind === 'absent') return { payer: 'not-signed-in' };

  const entries = Object.entries(auth.value).filter(
    (pair): pair is [string, Record<string, unknown>] => isRecord(pair[1])
  );
  if (entries.length === 0) return { payer: 'not-signed-in' };
  const xiaomi = entries.find(([id]) => id.startsWith('xiaomi'));
  if (!xiaomi) return { payer: 'api-key', via: entries.map(([id]) => id) };

  const [providerId, entry] = xiaomi;
  const baseUrl = isRecord(entry.metadata) ? entry.metadata.base_url : undefined;
  const host = endpointHost(baseUrl);
  if (host && !/(^|\.)xiaomimimo\.com(:\d+)?$/i.test(host)) return { payer: 'custom-endpoint', endpoint: host };

  switch (classifyKey(providerId, entry.key)) {
    case 'token-plan-team':
      return { payer: 'subscription', plan: 'MiMo Token Plan 团队版', tierUnknown: true };
    case 'token-plan':
      return { payer: 'subscription', plan: 'MiMo Token Plan', tierUnknown: true };
    case 'pay-as-you-go':
      return { payer: 'api-key', plan: 'MiMo 按量付费' };
    case 'unknown':
      return { payer: 'unknown', message: '小米的 key 不是 sk- / tp- / ttp- 开头，判不出是按量还是 Token Plan。' };
  }
}

export async function readMimocodeUsage(
  _ctx: AgentAuthContext,
  plan: SubscriptionPlanReading
): Promise<SubscriptionUsageReading> {
  switch (plan.payer) {
    case 'not-signed-in':
      return usageUnavailable('not-signed-in');
    case 'custom-endpoint':
      return usageUnavailable('custom-endpoint');
    case 'unknown':
      return usageUnavailable('error', { message: plan.message });
    default:
      // 余额 / Token Plan 余量都只在小米开放平台网页后台(要网页登录，key 查不了)。
      return plan.via ? usageUnavailable('not-reported') : usageUnavailable('vendor-console', { consoleUrl: MIMO_CONSOLE_URL });
  }
}

export const mimocodeSubscription: ISubscriptionBehavior = {
  readPlan: readMimocodePlan,
  readUsage: readMimocodeUsage,
};
