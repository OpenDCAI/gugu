import type { AgentAuthContext, SubscriptionPlanReading } from '@gugu/session-core/agents/plugins';

/**
 * 「订阅」读数里，读本机凭据文件的那几家(opencode / mimocode / qwen / pi / hermes)共用的小工具。
 *
 * 与 `helpers/subscription.ts` 的 `readJsonObject` 不同：这里**分得开**「文件不存在」与「读不出 / 解析不了」。
 * 前者是真读数(这台机器从没登过)⇒ `not-signed-in`;后者是仪器失败 ⇒ `unknown`。
 * ❌ 把读不出当成没登录(失败仪器的空输出不是阴性读数)。
 */
export type FileReading =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; value: Record<string, unknown> };

export async function readJsonFile(ctx: Pick<AgentAuthContext, 'fs'>, path: string): Promise<FileReading> {
  let content: string | null;
  try {
    content = await ctx.fs.read(path);
  } catch {
    return { kind: 'unreadable' };
  }
  if (content === null) return { kind: 'absent' };
  if (!content.trim()) return { kind: 'ok', value: {} };
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? { kind: 'ok', value: parsed } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

export async function readTextFile(
  ctx: Pick<AgentAuthContext, 'fs'>,
  path: string
): Promise<{ kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; text: string }> {
  try {
    const content = await ctx.fs.read(path);
    return content === null ? { kind: 'absent' } : { kind: 'ok', text: content };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 用户把这家的配置根挪走了(设了品牌变量)而手上这把 fs 照不到那里 ⇒ 读的不是引擎真读的那份。
 * 与各家 auth / modelCredential 的 guard 同构(理由见 `AgentAuthContext.fsFollowsConfigRoot`)。
 */
export function relocatedAway(ctx: Pick<AgentAuthContext, 'env' | 'fsFollowsConfigRoot'>, envVars: string[]): string | undefined {
  if (ctx.fsFollowsConfigRoot) return undefined;
  return envVars.find((name) => Boolean(ctx.env?.[name]?.trim()));
}

export function relocatedReading(envVar: string): SubscriptionPlanReading {
  return { payer: 'unknown', message: `配置目录被 ${envVar} 挪到了别处，咕咕读不到这家真用的那一份。` };
}

export function unreadableReading(path: string): SubscriptionPlanReading {
  return { payer: 'unknown', message: `~/${path} 读不出或不是合法的 JSON。` };
}
