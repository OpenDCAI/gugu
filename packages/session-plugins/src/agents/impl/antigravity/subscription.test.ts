import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { readAntigravityUsage, tierFromUserStatus, windowsFromAgyUsage } from './subscription';

/** agy 1.2.11 本机实测 `agy -p "/usage" --output-format json` 的输出(原样，只删了说明长句)。 */
const AGY_USAGE = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-19T20:56:45Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8, reset_time: '2026-10-13T01:56:45Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.555, reset_time: '2026-10-19T20:56:45Z' },
          ],
        },
      ],
    },
  },
});

/** IDE 缓存的形状:外层 base64 → 一段里面再有一段长 base64 → protobuf,档位编号后紧跟 0x12 + 长度 + 名字。 */
function ideUserStatus(tierId: string, name: string): string {
  const proto = Buffer.concat([
    Buffer.from('padding-before-'.repeat(20), 'latin1'),
    Buffer.from([0x0a, tierId.length]),
    Buffer.from(tierId, 'latin1'),
    Buffer.from([0x12, name.length]),
    Buffer.from(name, 'latin1'),
    Buffer.from('-padding-after'.repeat(20), 'latin1'),
  ]);
  const inner = proto.toString('base64');
  return Buffer.from(`userStatusSentinelKey\x00${inner}`, 'latin1').toString('base64');
}

describe('Antigravity 用量', () => {
  it('两组 × 两个窗口，剩余比例换成已用百分比', () => {
    expect(windowsFromAgyUsage(AGY_USAGE)).toEqual([
      { group: 'Gemini Models', windowMinutes: 10_080, usedPercent: 0, resetsAt: Date.parse('2026-10-19T20:56:45Z') },
      { group: 'Gemini Models', windowMinutes: 300, usedPercent: 20, resetsAt: Date.parse('2026-10-13T01:56:45Z') },
      { group: 'Claude and GPT models', windowMinutes: 10_080, usedPercent: 44.5, resetsAt: Date.parse('2026-10-19T20:56:45Z') },
    ]);
    expect(windowsFromAgyUsage('not json')).toEqual([]);
  });

  it('不是订阅登录就不起 agy —— 没登录时 agy -p 会自己弹 Google 登录页', async () => {
    const exec = vi.fn();
    const ctx = { cli: 'agy', env: { GEMINI_HOME: '/h/.gemini' }, exec, fs: {} } as unknown as AgentAuthContext;
    await expect(readAntigravityUsage(ctx, { payer: 'not-signed-in' })).resolves.toMatchObject({ reason: 'not-signed-in' });
    await expect(readAntigravityUsage(ctx, { payer: 'unknown' })).resolves.toMatchObject({ reason: 'not-reported' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('订阅时经启动器问 agy -p /usage,30 秒必停', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: AGY_USAGE, stderr: '' });
    const ctx = { cli: '/bin/agy', env: { GEMINI_HOME: '/h/.gemini' }, exec, fs: {} } as unknown as AgentAuthContext;
    const reading = await readAntigravityUsage(ctx, { payer: 'subscription', plan: 'Google AI Pro' });
    expect(reading.kind).toBe('windows');
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/env',
      expect.arrayContaining(['GEMINI_HOME=/h/.gemini', '/bin/agy', '-p', '/usage', '--output-format', 'json']),
      { timeout: 30_000 }
    );
  });
});

describe('Antigravity 套餐(IDE 缓存)', () => {
  it('解出档位编号与 Google 自己给的名字', () => {
    expect(tierFromUserStatus(ideUserStatus('g1-pro-tier', 'Google AI Pro'))).toEqual({
      id: 'g1-pro-tier',
      name: 'Google AI Pro',
      tierUnknown: false,
    });
  });

  it('Ultra 两档名字一样，编号对应关系没验证 ⇒ 档位读不出', () => {
    expect(tierFromUserStatus(ideUserStatus('g1-ultra-lite-tier', 'Google AI Ultra'))).toMatchObject({
      name: 'Google AI Ultra',
      tierUnknown: true,
    });
  });

  it('没有档位 / 空值 ⇒ null(不猜)', () => {
    expect(tierFromUserStatus('')).toBeNull();
    expect(tierFromUserStatus(Buffer.from('nothing here').toString('base64'))).toBeNull();
  });
});
