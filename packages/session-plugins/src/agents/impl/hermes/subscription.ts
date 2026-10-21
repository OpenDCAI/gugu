import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import { chatgptPlanName, chatgptPlanTypeOf, endpointHost, objectAt, usageUnavailable } from '../../helpers/subscription';
import {
  isRecord,
  readJsonFile,
  readTextFile,
  relocatedAway,
  relocatedReading,
} from '../../helpers/subscription-keyed';

/**
 * Hermes Agent 的「订阅」读数(product spec)。
 *
 * Hermes 本身免费，背后接哪家由 `$HERMES_HOME/config.yaml` 的 `model.provider` 定(缺省 `auto` = 按凭据自动挑)。
 * 登录类凭据在 `$HERMES_HOME/auth.json`:`{version, providers:{<id>:{…}}, active_provider}`;
 * Codex 的令牌在 `providers['openai-codex'].tokens.{access_token,id_token}`。
 * 出处：NousResearch/hermes-agent(本机 ~/.hermes/hermes-agent,提交 ee000768)`cli-config.yaml.example:38-70`、
 * `hermes_cli/auth.py:1044-1097,1280-1346,3693-3710`;HERMES_HOME 缺省 `~/.hermes`(Windows 为
 * `%LOCALAPPDATA%\hermes`,`hermes_constants.py:53-59`)。
 *
 * 档位:接 Nous Portal 时，档位名只由 Hermes 自己的后台(`hermes serve` 的 `subscription.state`)报，
 * 而那要 Hermes 自己续 Nous 的登录(续期凭据一次性)⇒ 咕咕不读，只写到「Nous Portal」。
 * 用量同理 ⇒ `not-reported`。
 *
 * YAML:session-plugins 没有 yaml 依赖，这里只认 `model:` 块下两行 `provider:` / `base_url:`(Hermes 示例
 * 配置就是这个形状);认不出就答 `unknown`,❌ 猜。
 */
const RELOCATION_VARS = ['HERMES_HOME'];
const SUBSCRIPTION_PROVIDERS: Record<string, string> = {
  nous: 'Nous Portal',
  'openai-codex': 'ChatGPT',
  anthropic: 'Claude',
  copilot: 'GitHub Copilot',
};
const CUSTOM_PROVIDERS = new Set(['custom', 'ollama', 'vllm', 'llamacpp', 'lmstudio']);
const PROVIDER_NAMES: Record<string, string> = {
  ...SUBSCRIPTION_PROVIDERS,
  'nous-api': 'Nous Portal',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  zai: 'Z.ai',
  'kimi-coding': 'Kimi',
  xiaomi: 'Xiaomi MiMo',
};

function hermesHome(): string {
  return process.platform === 'win32' ? 'AppData/Local/hermes' : '.hermes';
}

/** 只取 `model:` 块下的 `provider` 与 `base_url`。 */
export function parseHermesModelBlock(yaml: string): { provider?: string; baseUrl?: string } {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^model:\s*(#.*)?$/.test(line));
  if (start < 0) return {};
  const out: { provider?: string; baseUrl?: string } = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // 下一个顶层键
    const match = line.match(/^\s+(provider|base_url):\s*(.*)$/);
    if (!match) continue;
    const value = match[2]!.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;
    if (match[1] === 'provider') out.provider ??= value;
    else out.baseUrl ??= value;
  }
  return out;
}

export async function readHermesPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  const relocated = relocatedAway(ctx, RELOCATION_VARS);
  if (relocated) return relocatedReading(relocated);

  const home = hermesHome();
  const config = await readTextFile(ctx, `${home}/config.yaml`);
  const auth = await readJsonFile(ctx, `${home}/auth.json`);
  if (config.kind === 'unreadable' || auth.kind === 'unreadable') {
    return { payer: 'unknown', message: 'Hermes 的 config.yaml 或 auth.json 读不出。' };
  }
  const stored = auth.kind === 'ok' && isRecord(auth.value.providers) ? auth.value.providers : {};
  const activeFromStore = auth.kind === 'ok' && typeof auth.value.active_provider === 'string'
    ? auth.value.active_provider
    : undefined;
  const block = config.kind === 'ok' ? parseHermesModelBlock(config.text) : {};

  const storedIds = Object.keys(stored);
  const provider =
    (block.provider && block.provider !== 'auto' ? block.provider : undefined)
    ?? activeFromStore
    ?? (storedIds.length === 1 ? storedIds[0] : undefined);
  if (!provider) {
    if (config.kind === 'absent' && storedIds.length === 0) return { payer: 'not-signed-in' };
    return { payer: 'unknown', message: 'Hermes 设为按凭据自动选择，判不出接的是哪家。' };
  }

  if (CUSTOM_PROVIDERS.has(provider)) {
    const host = endpointHost(block.baseUrl);
    return host ? { payer: 'custom-endpoint', endpoint: host } : { payer: 'unknown', message: 'Hermes 接的自定义服务没写地址。' };
  }
  const name = PROVIDER_NAMES[provider] ?? provider;
  if (Object.hasOwn(SUBSCRIPTION_PROVIDERS, provider)) {
    // anthropic / copilot 也能只给 key(环境变量)。auth.json 里有这家的登录态才算订阅。
    const loggedIn = Object.hasOwn(stored, provider) && isRecord(stored[provider]);
    if (provider !== 'nous' && !loggedIn) return { payer: 'api-key', via: [name] };
    if (provider === 'openai-codex') {
      const tokens = objectAt(stored[provider], 'tokens');
      const plan = chatgptPlanName(chatgptPlanTypeOf(tokens?.id_token) ?? chatgptPlanTypeOf(tokens?.access_token));
      if (plan) return { payer: 'subscription', plan, via: [name] };
    }
    if (provider === 'nous' && !loggedIn) return { payer: 'not-signed-in' };
    return { payer: 'subscription', plan: name, tierUnknown: true, via: [name] };
  }
  return { payer: 'api-key', via: [name] };
}

export async function readHermesUsage(_ctx: AgentAuthContext, plan: SubscriptionPlanReading): Promise<SubscriptionUsageReading> {
  switch (plan.payer) {
    case 'not-signed-in':
      return usageUnavailable('not-signed-in');
    case 'custom-endpoint':
      return usageUnavailable('custom-endpoint');
    case 'unknown':
      return usageUnavailable('error', { message: plan.message });
    default:
      // Nous 的余额只经 `hermes serve` 的 JSON-RPC 报，且要 Hermes 自己续登录 —— 咕咕 ❌ 替它续。
      return usageUnavailable('not-reported');
  }
}

export const hermesSubscription: ISubscriptionBehavior = {
  readPlan: readHermesPlan,
  readUsage: readHermesUsage,
};
