import { stat } from 'node:fs/promises';
import { join } from 'node:path';
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
  readJsonObject,
  usageUnavailable,
  usageWindows,
} from '../../helpers/subscription';
import { ANTIGRAVITY_CLI_SETTINGS_PATH, ANTIGRAVITY_HOME_ENV, antigravityCliAuthStatus } from './auth';
import { ANTIGRAVITY_LAUNCH_SCRIPT } from './session-bundle';

/**
 * Antigravity 的「订阅」读数(product spec)。读的是终端版 `agy` 那条登录(能力里声明
 * `program: antigravity-cli`,宿主据此把 `ctx.cli` 解析成 `agy`)。
 *
 * 用量:`agy -p "/usage" --output-format json` —— 官方命令(antigravity.google/docs/cli/commands/usage),
 * agy 1.1.11 更新日志写明「不起对话、不花额度」;本机 1.2.11 实测 10 秒、`num_turns:0`,
 * `command.data.groups[].buckets[]` 每格 `{window: '5h'|'weekly', remaining_fraction, reset_time}`。
 * ⚠️ 没登录时 `agy -p` 会自己起 Google 登录流程并在约 60 秒后打开浏览器(2026-10-13 调研时实撞)⇒
 *    只在 `agy models` 已经答「登着」之后才问，而且 30 秒必停 —— 赶在它可能弹浏览器之前。
 *
 * 套餐:agy 本地不存档位;Antigravity 桌面版(IDE)把服务端答的用户状态缓存在
 * `User/globalStorage/state.vscdb` 的 `antigravityUnifiedStateSync.userStatus`(两层 base64 包着 protobuf,
 * 里面是 `g1-pro-tier` + 「Google AI Pro」,本机实测)。它只和 IDE 上一次运行一样新 ⇒ 随读数给 `planAsOf`。
 * 没装 IDE / 读不出 ⇒ 档位读不出。Ultra 的 5x / 20x 只能按内部编号分，对应关系没验证 ⇒ Ultra 一律 `tierUnknown`。
 */

const AGY_USAGE_TIMEOUT_MS = 30_000;
const SQLITE_TIMEOUT_MS = 5_000;
const USER_STATUS_KEY = 'antigravityUnifiedStateSync.userStatus';
const GOOGLE_USAGE_PAGE = 'https://antigravity.google/docs/plans';

export function antigravitySubscriptionBehavior(): ISubscriptionBehavior {
  return { readPlan: readAntigravityPlan, readUsage: readAntigravityUsage };
}

export async function readAntigravityPlan(ctx: AgentAuthContext): Promise<SubscriptionPlanReading> {
  if (process.platform === 'win32') return { payer: 'unknown', message: 'Windows 上没有 agy 终端版，它的套餐读不到。' };
  const settings = await readJsonObject(ctx, ANTIGRAVITY_CLI_SETTINGS_PATH);
  if (settings?.modelProvider === 'gemini') return { payer: 'api-key' };

  const auth = await antigravityCliAuthStatus(ctx);
  if (auth.kind === 'unauthenticated') return { payer: 'not-signed-in' };
  if (auth.kind === 'unknown') return { payer: 'unknown', ...(auth.message ? { message: auth.message } : {}) };

  const cached = await readIdeTier(ctx);
  if (!cached) return { payer: 'subscription', plan: 'Google AI', tierUnknown: true };
  return {
    payer: 'subscription',
    plan: cached.name,
    ...(cached.tierUnknown ? { tierUnknown: true } : {}),
    ...(cached.asOf !== undefined ? { planAsOf: cached.asOf } : {}),
  };
}

type IdeTier = { id: string; name: string; tierUnknown: boolean; asOf?: number };

/** IDE 的状态库在**真** home 下(ctx.fs 锚在咕咕的托管 home 上，所以这里按 `HOME` 拼绝对路径)。 */
async function readIdeTier(ctx: AgentAuthContext): Promise<IdeTier | null> {
  const home = ctx.env.HOME?.trim();
  if (!home) return null;
  const db =
    process.platform === 'darwin'
      ? join(home, 'Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb')
      : join(home, '.config/Antigravity IDE/User/globalStorage/state.vscdb');
  const modified = await stat(db).then((info) => info.mtimeMs, () => null);
  if (modified === null) return null;
  try {
    const { stdout } = await ctx.exec(
      'sqlite3',
      ['-readonly', db, `select value from ItemTable where key='${USER_STATUS_KEY}'`],
      { timeout: SQLITE_TIMEOUT_MS }
    );
    const tier = tierFromUserStatus(stdout.trim());
    return tier ? { ...tier, asOf: modified } : null;
  } catch {
    return null;
  }
}

/**
 * 缓存值 → 档位。外层 base64 解开后里面还有一段 base64 包着的 protobuf;在里面找档位编号，
 * 紧跟着的那个字符串字段(protobuf tag 0x12 + 长度)就是 Google 自己给的名字。
 */
export function tierFromUserStatus(value: string): { id: string; name: string; tierUnknown: boolean } | null {
  if (!value) return null;
  const outer = Buffer.from(value, 'base64').toString('latin1');
  const candidates = [outer, ...(outer.match(/[A-Za-z0-9+/=]{200,}/g) ?? []).map((run) => Buffer.from(run, 'base64').toString('latin1'))];
  for (const text of candidates) {
    const match = /(g1-[a-z-]+-tier|free-tier|standard-tier|legacy-tier)\x12([\s\S])/.exec(text);
    if (!match) continue;
    const id = match[1]!;
    const length = match[2]!.charCodeAt(0);
    const start = match.index + id.length + 2;
    const name = text.slice(start, start + length);
    if (name.length !== length || !/^[\x20-\x7e]+$/.test(name)) continue;
    return { id, name, tierUnknown: id.startsWith('g1-ultra') };
  }
  return null;
}

export async function readAntigravityUsage(
  ctx: AgentAuthContext,
  plan: SubscriptionPlanReading
): Promise<SubscriptionUsageReading> {
  if (plan.payer === 'not-signed-in') return usageUnavailable('not-signed-in');
  if (plan.payer !== 'subscription') return usageUnavailable('not-reported');
  const geminiHome = ctx.env[ANTIGRAVITY_HOME_ENV]?.trim();
  if (!geminiHome) return usageUnavailable('error', { message: `宿主没给 ${ANTIGRAVITY_HOME_ENV},找不到 agy 的托管根。` });
  try {
    // 与登录读数同一个启动器(只换 agy 这一个进程的 HOME,mac 上接好钥匙串软链)。
    const { stdout } = await ctx.exec(
      '/usr/bin/env',
      [
        `${ANTIGRAVITY_HOME_ENV}=${geminiHome}`,
        '/bin/sh',
        '-c',
        ANTIGRAVITY_LAUNCH_SCRIPT,
        ctx.cli,
        '-p',
        '/usage',
        '--output-format',
        'json',
      ],
      { timeout: AGY_USAGE_TIMEOUT_MS }
    );
    const windows = windowsFromAgyUsage(stdout);
    return windows.length > 0
      ? usageWindows(windows)
      : usageUnavailable('error', { message: 'agy 的 /usage 没有给出额度窗口。', consoleUrl: GOOGLE_USAGE_PAGE });
  } catch (error) {
    return usageUnavailable('error', { message: errorMessage(error), consoleUrl: GOOGLE_USAGE_PAGE });
  }
}

const WINDOW_MINUTES: Record<string, number> = { '5h': 300, weekly: 10_080 };

/** `agy -p /usage --output-format json` 的输出 → 窗口(剩余比例换成已用百分比)。 */
export function windowsFromAgyUsage(stdout: string): SubscriptionUsageWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const groups = (parsed as { command?: { data?: { groups?: unknown } } } | null)?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: SubscriptionUsageWindow[] = [];
  for (const group of groups as Array<{ name?: unknown; buckets?: unknown }>) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets as Array<Record<string, unknown>>) {
      const remaining = finiteNumber(bucket.remaining_fraction);
      if (remaining === undefined) continue;
      const minutes = typeof bucket.window === 'string' ? WINDOW_MINUTES[bucket.window] : undefined;
      const resetsAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        ...(typeof group.name === 'string' ? { group: group.name } : {}),
        ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
        usedPercent: clampPercent(Math.round((1 - remaining) * 1000) / 10),
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      });
    }
  }
  return windows;
}
