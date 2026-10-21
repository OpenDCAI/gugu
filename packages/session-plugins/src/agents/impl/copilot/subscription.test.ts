import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copilotPlanName,
  readCopilotPlan,
  readCopilotUsage,
  resetCopilotSubscriptionCache,
} from './subscription';

/** 10-13 本机 `gh api /copilot_internal/user` 的实测形状(只留判读用到的字段)。 */
const FREE_USER = {
  copilot_plan: 'individual',
  access_type_sku: 'free_limited_copilot',
  quota_reset_date: '2026-11-01',
  quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
  token_based_billing: true,
  login: 'someone',
  quota_snapshots: {
    chat: { entitlement: 200, remaining: 150, percent_remaining: 75.0, unlimited: false, has_quota: true, quota_id: 'chat' },
    completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100.0, unlimited: false, has_quota: true },
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0.0, unlimited: false, has_quota: false },
  },
};

type ExecImpl = (command: string, args?: string[]) => Promise<{ stdout: string; stderr: string }>;

function ctx(exec: ExecImpl, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'copilot',
    env,
    exec: vi.fn(exec),
    fs: { read: vi.fn(), write: vi.fn(), delete: vi.fn(), exists: vi.fn(), list: vi.fn() },
  };
}

/** 钥匙串里没有 `copilot-cli`(security 退出码 44),gh 答 `user`。 */
const ghAnswers = (user: unknown): ExecImpl => async (command) => {
  if (command === 'security') throw Object.assign(new Error('not found'), { code: 44 });
  if (command === 'gh') return { stdout: JSON.stringify(user), stderr: '' };
  throw new Error(`unexpected ${command}`);
};

beforeEach(() => {
  resetCopilotSubscriptionCache();
  // 跑测试的机器(CI)可能自带 GITHUB_TOKEN:判读比的是「ctx.env 与本进程环境里是不是同一把」,这里两边都清空。
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('GitHub Copilot 订阅读数', () => {
  it('Free 账号 ⇒ Copilot Free;本月额度按快照给，不限量与额度为 0 的不画', async () => {
    const c = ctx(ghAnswers(FREE_USER));
    const plan = await readCopilotPlan(c);
    expect(plan).toEqual({ payer: 'subscription', plan: 'Copilot Free' });
    const usage = await readCopilotUsage(c, plan);
    const resetsAt = Date.parse('2026-11-01T00:00:00.000Z');
    expect(usage).toMatchObject({
      kind: 'windows',
      windows: [
        { group: 'chat', monthly: true, usedPercent: 25, used: 50, limit: 200, resetsAt },
        { group: 'completions', monthly: true, usedPercent: 0, used: 0, limit: 2000, resetsAt },
      ],
    });
    // 套餐 + 用量两次读数只问了 GitHub 一次。
    expect((c.exec as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
  });

  it('付费档的 sku 没有一手样本 ⇒ 只写 Copilot、标档位读不出;Business / Enterprise 认得出', () => {
    expect(copilotPlanName({ copilot_plan: 'individual', access_type_sku: 'monthly_subscriber' })).toEqual({
      plan: 'Copilot',
      tierUnknown: true,
    });
    expect(copilotPlanName({ copilot_plan: 'business', access_type_sku: 'copilot_for_business_seat_quota' })).toEqual({
      plan: 'Copilot Business',
    });
    expect(copilotPlanName({ copilot_plan: 'enterprise' })).toEqual({ plan: 'Copilot Enterprise' });
  });

  it('Copilot 用的是另一把令牌 ⇒ 不去读 gh 那个账号', async () => {
    const exec = vi.fn(ghAnswers(FREE_USER));
    const c = ctx(exec, { COPILOT_GITHUB_TOKEN: 'ghp_x' });
    const plan = await readCopilotPlan(c);
    expect(plan).toMatchObject({ payer: 'unknown' });
    await expect(readCopilotUsage(c, plan)).resolves.toMatchObject({ reason: 'other-login' });
    expect(exec.mock.calls.some(([command]) => command === 'gh')).toBe(false);
    expect(exec.mock.calls.flat().join(' ')).not.toContain('ghp_x');
  });

  it.runIf(process.platform === 'darwin')('Copilot 自己 /login 过(钥匙串里有 copilot-cli)⇒ other-login,❌ 带 -w', async () => {
    const exec = vi.fn<ExecImpl>(async (command) => {
      if (command === 'security') return { stdout: 'keychain: "login"', stderr: '' };
      return { stdout: JSON.stringify(FREE_USER), stderr: '' };
    });
    const c = ctx(exec);
    const plan = await readCopilotPlan(c);
    await expect(readCopilotUsage(c, plan)).resolves.toMatchObject({ reason: 'other-login' });
    expect(exec.mock.calls.find(([command]) => command === 'security')?.[1]).not.toContain('-w');
  });

  it('gh 不在 / 没登录 ⇒ 判不出，用量是 error 并带原因', async () => {
    const c = ctx(async (command) => {
      if (command === 'security') throw Object.assign(new Error('nf'), { code: 44 });
      throw Object.assign(new Error('exit 4'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
    });
    const plan = await readCopilotPlan(c);
    expect(plan).toMatchObject({ payer: 'unknown', message: expect.stringContaining('gh auth login') });
    await expect(readCopilotUsage(c, plan)).resolves.toMatchObject({ kind: 'unavailable', reason: 'error' });
  });
});
