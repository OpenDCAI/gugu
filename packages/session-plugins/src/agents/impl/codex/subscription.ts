import { createInterface } from 'node:readline';
import type {
  AgentAuthContext,
  ISubscriptionBehavior,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';
import { spawnOwnedChild } from '@gugu/session-core/exec';
import { parse as parseTOML } from 'smol-toml';
import { requestSubscriptionJson } from '../../helpers/subscription-http';
import { readCodexCredentials } from './credentials';
import {
  chatgptPlanName,
  chatgptPlanTypeOf,
  clampPercent,
  endpointHost,
  errorMessage,
  finiteNumber,
  jwtPayload,
  objectAt,
  usageUnavailable,
  usageWindows,
} from '../../helpers/subscription';

/**
 * Codex 的「订阅」读数(product spec)。出处对照 openai/codex rust-v0.160.0:
 *
 * 套餐:`$CODEX_HOME/auth.json`(默认 `~/.codex/auth.json`)。`auth_mode: 'chatgpt'` 时登录令牌
 * (`tokens.id_token`)里的 `https://api.openai.com/auth`.`chatgpt_plan_type` 就是档位
 * (`login/src/auth/manager.rs:678`;app-server `account/read` 的 `planType` 也取它)。
 * ⚠️ 先看 `config.toml`:`model_provider` 指到了自定义 provider(中转 / 自建网关)时推理不走 ChatGPT 订阅,
 *    哪怕登着 ChatGPT —— 照实说「自定义服务」。provider 的**名字**可以叫 "OpenAI"(本机就是),判的是 id。
 *
 * 用量:参考 cockpit-tools codex_quota.rs，从 wham/usage 读取结构化窗口。
 * 凭据读取遵循所选 profile 的 file/keyring 模式；令牌过期时由 Codex 自己续期。
 * primary/secondary 按返回的 limit_window_seconds 命名，不按位置猜窗口时长。
 */

const BUILTIN_PROVIDERS = new Set(['openai']);
const APP_SERVER_TIMEOUT_MS = 30_000;
const CODEX_USAGE_PAGE = 'https://chatgpt.com/codex/settings/usage';

export function codexSubscriptionBehavior(): ISubscriptionBehavior {
  return { readPlan: readCodexPlan, readUsage: readCodexUsage };
}

export async function readCodexPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  // 用户自己挪了 CODEX_HOME 而 fs 照不到 ⇒ 读出来的会是别的账号，判不出。
  if (ctx.env.CODEX_HOME?.trim() && !ctx.fsFollowsConfigRoot) {
    return { payer: 'unknown', message: 'CODEX_HOME 指到了别处，咕咕读不到那一份。' };
  }
  const configRaw = await ctx.fs.read('.codex/config.toml').catch(() => null);
  const custom = configRaw ? customProviderOf(configRaw) : null;
  const officialApiKey = custom === 'api.openai.com' && (ctx.env.OPENAI_API_KEY?.trim() || ctx.env.CODEX_API_KEY?.trim());
  if (custom && !officialApiKey) return { payer: 'custom-endpoint', endpoint: custom };
  if (ctx.env.OPENAI_API_KEY?.trim() || ctx.env.CODEX_API_KEY?.trim()) return { payer: 'api-key' };
  return planFromAuthJson(await readCodexCredentials(ctx));
}

/** `config.toml` 里选中的自定义 provider → 它的主机名(没写 base_url 就给 provider id)。内置的 openai ⇒ null。 */
export function customProviderOf(raw: string): string | null {
  let config: Record<string, unknown>;
  try {
    config = parseTOML(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const selected = typeof config.model_provider === 'string' ? config.model_provider.trim() : '';
  if (!selected || BUILTIN_PROVIDERS.has(selected)) return null;
  const provider = objectAt(objectAt(config, 'model_providers'), selected);
  return endpointHost(provider?.base_url) ?? selected;
}

export function planFromAuthJson(auth: Record<string, unknown> | null): SubscriptionPlanReading {
  if (!auth) return { payer: 'not-signed-in' };
  if (auth.auth_mode === 'apikey') return { payer: 'api-key' };
  if (auth.auth_mode !== 'chatgpt') return { payer: 'unknown' };
  const tokens = objectAt(auth, 'tokens');
  const name = chatgptPlanName(chatgptPlanTypeOf(tokens?.id_token));
  return name ? { payer: 'subscription', plan: name } : { payer: 'subscription', plan: 'ChatGPT', tierUnknown: true };
}

export async function readCodexUsage(
  ctx: AgentAuthContext,
  plan: SubscriptionPlanReading
): Promise<SubscriptionUsageReading> {
  if (plan.payer === 'not-signed-in') return usageUnavailable('not-signed-in');
  if (plan.payer === 'custom-endpoint') return usageUnavailable('custom-endpoint');
  if (plan.payer !== 'subscription') return usageUnavailable('not-reported');
  try {
    let credentials = await readCodexCredentials(ctx);
    let tokens = objectAt(credentials, 'tokens');
    const accessToken = tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('Codex 登录凭据中没有可读取的访问令牌。');
    // Refresh through Codex, the authority for this profile, rather than rotating its token independently.
    const payload = jwtPayload(accessToken);
    if (typeof payload?.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      await askAppServer(ctx, 'account/read', { refreshToken: true });
      credentials = await readCodexCredentials(ctx);
      tokens = objectAt(credentials, 'tokens');
    }
    const token = tokens?.access_token;
    if (typeof token !== 'string' || !token) throw new Error('Codex 登录已失效，请重新登录。');
    const accountId = tokens?.account_id;
    const response = await requestSubscriptionJson(ctx, 'https://chatgpt.com/backend-api/wham/usage', {
      authorization: `Bearer ${token}`,
      ...(typeof accountId === 'string' && accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    });
    const windows = windowsFromUsage(response);
    return windows.length > 0
      ? usageWindows(windows)
      : usageUnavailable('error', { message: 'Codex 答了，但没有任何额度窗口。', consoleUrl: CODEX_USAGE_PAGE });
  } catch (error) {
    return usageUnavailable('error', { message: errorMessage(error), consoleUrl: CODEX_USAGE_PAGE });
  }
}

/** cockpit-tools codex_quota.rs: primary/secondary are positions; duration supplies their actual labels. */
export function windowsFromUsage(response: unknown, now = Date.now()): SubscriptionUsageWindow[] {
  const snapshots: Array<[string | undefined, unknown]> = [[undefined, objectAt(response, 'rate_limit')]];
  const additional = (response as { additional_rate_limits?: unknown } | null)?.additional_rate_limits;
  if (Array.isArray(additional)) for (const item of additional) {
    const name = item?.limit_name ?? item?.metered_feature;
    if (typeof name === 'string') snapshots.push([name, item.rate_limit]);
  }
  const windows: SubscriptionUsageWindow[] = [];
  for (const [group, snapshot] of snapshots) for (const key of ['primary_window', 'secondary_window']) {
    const window = objectAt(snapshot, key);
    const usedPercent = finiteNumber(window?.used_percent);
    if (usedPercent === undefined) continue;
    const seconds = finiteNumber(window?.limit_window_seconds);
    const resetAt = finiteNumber(window?.reset_at);
    const resetAfter = finiteNumber(window?.reset_after_seconds);
    windows.push({
      ...(group ? { group } : {}),
      ...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
      usedPercent: clampPercent(usedPercent),
      ...(resetAt !== undefined ? { resetsAt: resetAt * 1000 } : resetAfter !== undefined && resetAfter >= 0 ? { resetsAt: now + resetAfter * 1000 } : {}),
    });
  }
  return windows;
}

/**
 * 起一个 `codex app-server`,握手、问一句、拿到回答就停掉整棵进程树。
 * env 用宿主给的那份(代理、CODEX_HOME 都在里面);app-server 的 stderr 只留最后一段做报错原话。
 */
async function askAppServer(ctx: AgentAuthContext, method: string, params: unknown): Promise<unknown> {
  const binary = ctx.env.GUGU_CODEX_BIN?.trim() || ctx.cli;
  let failure: Error | null = null;
  const owned = spawnOwnedChild(binary, ['app-server'], {
    env: ctx.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    onError: (error) => {
      failure = error;
    },
  });
  const child = owned.child;
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
    else waiter.resolve(message.result);
  });
  let nextId = 1;
  const request = (name: string, body: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ id, method: name, params: body })}\n`);
    });
  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => reject(failure ?? new Error(`codex app-server 退出了(${code}):${stderrTail.trim().split('\n').pop() ?? ''}`)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`codex app-server ${APP_SERVER_TIMEOUT_MS / 1000} 秒内没有回答`)), APP_SERVER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        await request('initialize', { clientInfo: { name: 'gugu', title: 'Gugu', version: '0' }, capabilities: null });
        child.stdin!.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        return request(method, params);
      })(),
      exited,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    lines.close();
    exited.catch(() => undefined);
    await owned.stop({ graceMs: 2_000 }).catch(() => undefined);
  }
}
