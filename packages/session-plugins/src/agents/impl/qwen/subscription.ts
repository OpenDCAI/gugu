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
 * Qwen Code 的「订阅」读数(product spec)。
 *
 * 读用户层 `~/.qwen/settings.json`(`QWEN_HOME` 会把它挪走):
 *  · `security.auth.selectedType` —— 用的哪种协议(openai / qwen-oauth / gemini …);
 *  · `model.name` 与 `modelProviders[<selectedType>][]` 里 id 相同的那一条的 `baseUrl` / `envKey`。
 * 再照 Qwen 自己的预设认出是哪种计费(@qwen-code/qwen-code 0.21.15 打包产物
 * `chunks/chunk-L7RG5PVT.js` 的 `packages/core/src/providers/presets/alibaba-coding-plan.ts` 与
 * `alibaba-token-plan.ts` 两段，同一套判据也是它状态栏 `getAuthDisplayType` 用的):
 *  · Coding Plan:`https://coding.dashscope.aliyuncs.com/v1` / `coding-intl…`,key 变量 `BAILIAN_CODING_PLAN_API_KEY`;
 *  · Token Plan:`https://token-plan.{cn-beijing,ap-southeast-1}.maas.aliyuncs.com/compatible-mode/v1`,
 *    key 变量 `BAILIAN_TOKEN_PLAN_API_KEY`;
 *  · 百炼按量:`dashscope(-intl).aliyuncs.com/compatible-mode/v1`。
 * 百炼把订阅做成「发一把 key」:Lite / Pro 档位与余量只在阿里云控制台
 * (官方:https://help.aliyun.com/zh/model-studio/coding-plan 「在 Coding Plan 页面可以查看用量」;
 * 国际站 https://docs.modelstudio.console.alibabacloud.com/en/model-studio/coding-plan)。
 * Qwen OAuth 免费额度 2026-04-15 已停(QwenLM/qwen-code PR #3291)。
 */
const SETTINGS_PATH = '.qwen/settings.json';
const RELOCATION_VARS = ['QWEN_HOME'];
const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';
const TOKEN_PLAN_ENV_KEY = 'BAILIAN_TOKEN_PLAN_API_KEY';

export const BAILIAN_CONSOLE_URL = 'https://bailian.console.aliyun.com/';
export const MODELSTUDIO_CODING_PLAN_CONSOLE_URL =
  'https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/coding-plan';
export const MODELSTUDIO_CONSOLE_URL = 'https://modelstudio.console.alibabacloud.com/';

const PLAN_CODING = '百炼 Coding Plan';
const PLAN_TOKEN = '百炼 Token Plan';

function activeProvider(settings: Record<string, unknown>, selectedType: string | undefined) {
  const providers = isRecord(settings.modelProviders) ? settings.modelProviders : undefined;
  const list = selectedType && providers && Array.isArray(providers[selectedType]) ? providers[selectedType] : [];
  const models = (list as unknown[]).filter(isRecord);
  const modelName = isRecord(settings.model) && typeof settings.model.name === 'string' ? settings.model.name : undefined;
  return models.find((entry) => entry.id === modelName) ?? models[0];
}

export async function readQwenPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const relocated = relocatedAway(ctx, RELOCATION_VARS);
  if (relocated) return relocatedReading(relocated);

  const file = await readJsonFile(ctx, SETTINGS_PATH);
  if (file.kind === 'unreadable') return unreadableReading(SETTINGS_PATH);
  if (file.kind === 'absent') return { payer: 'not-signed-in' };
  const settings = file.value;
  const auth = isRecord(settings.security) && isRecord(settings.security.auth) ? settings.security.auth : {};
  const selectedType = typeof auth.selectedType === 'string' ? auth.selectedType : undefined;
  if (!selectedType) return { payer: 'not-signed-in' };
  if (selectedType === 'qwen-oauth') {
    return { payer: 'unknown', message: 'Qwen OAuth 免费额度已于 2026-04-15 停用，这份登录多半已经用不了。' };
  }

  const provider = activeProvider(settings, selectedType);
  const baseUrl = provider?.baseUrl ?? auth.baseUrl ?? ctx.env?.OPENAI_BASE_URL;
  const envKey = typeof provider?.envKey === 'string' ? provider.envKey : undefined;
  const host = endpointHost(baseUrl)?.toLowerCase();

  if (envKey === CODING_PLAN_ENV_KEY || (host && /^coding(-intl)?\.dashscope\.aliyuncs\.com$/.test(host))) {
    return { payer: 'subscription', plan: PLAN_CODING, tierUnknown: true };
  }
  if (envKey === TOKEN_PLAN_ENV_KEY || (host && /^token-plan\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(host))) {
    return { payer: 'subscription', plan: PLAN_TOKEN, tierUnknown: true };
  }
  if (host && /^dashscope(-intl)?\.aliyuncs\.com$/.test(host)) return { payer: 'api-key', plan: '阿里云百炼按量' };
  if (host) return { payer: 'custom-endpoint', endpoint: host };
  return { payer: 'api-key' };
}

export async function readQwenUsage(ctx: AgentAuthContext, plan: SubscriptionPlanReading): Promise<SubscriptionUsageReading> {
  switch (plan.payer) {
    case 'not-signed-in':
      return usageUnavailable('not-signed-in');
    case 'custom-endpoint':
      return usageUnavailable('custom-endpoint');
    case 'unknown':
      return usageUnavailable('error', { message: plan.message });
    case 'subscription':
    case 'api-key': {
      if (plan.plan !== PLAN_CODING && plan.plan !== PLAN_TOKEN && plan.plan !== '阿里云百炼按量') {
        return usageUnavailable('not-reported');
      }
      // 余量只在控制台。国际站与中国站是两个控制台 —— 按这份配置真打到的那个地址选。
      const settings = await readJsonFile(ctx, SETTINGS_PATH);
      const intl = settings.kind === 'ok' && /coding-intl|ap-southeast-1|dashscope-intl/.test(JSON.stringify(settings.value));
      const consoleUrl = !intl
        ? BAILIAN_CONSOLE_URL
        : plan.plan === PLAN_CODING
          ? MODELSTUDIO_CODING_PLAN_CONSOLE_URL
          : MODELSTUDIO_CONSOLE_URL;
      return usageUnavailable('vendor-console', { consoleUrl });
    }
  }
}

export const qwenSubscription: ISubscriptionBehavior = {
  readPlan: readQwenPlan,
  readUsage: readQwenUsage,
};
