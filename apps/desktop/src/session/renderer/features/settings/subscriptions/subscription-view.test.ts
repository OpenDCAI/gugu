import { describe, expect, it } from 'vitest';
import { zhCNSubscriptionMessages } from '@renderer/localization/messages-subscriptions';
import { formatPercent, quotaReading, payerLine, planLabel, planNotes, unavailableText, usedText, windowLabel } from './subscription-view';

/** 用真词表(中文)渲染 —— 断言的就是用户读到的那句话。 */
const translate = (key: string, values?: Record<string, unknown>) => {
  const template = (zhCNSubscriptionMessages as Record<string, string>)[key];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
};
const t = translate as Parameters<typeof payerLine>[1];

describe('「订阅」页一行里的字', () => {
  it('谁在付钱 + 套餐;档位读不出就明说', () => {
    expect(payerLine({ payer: 'subscription', plan: 'Claude Max 20x' }, t, true)).toBe('你的订阅 · Claude Max 20x');
    expect(payerLine({ payer: 'subscription', plan: 'Google AI Ultra', tierUnknown: true }, t, false)).toBe(
      '你的订阅 · Google AI Ultra(档位读不出)'
    );
    expect(payerLine({ payer: 'api-key', plan: 'MiMo 按量付费' }, t, false)).toBe('你自己的 API key · MiMo 按量付费');
    expect(payerLine({ payer: 'custom-endpoint', endpoint: '198.51.100.37:9000' }, t, false)).toBe(
      '自定义服务 198.51.100.37:9000'
    );
  });

  it('没登自己的账号:这家能走咕咕积分时补一句', () => {
    expect(payerLine({ payer: 'not-signed-in' }, t, true)).toBe('未登录（使用咕咕积分）');
    expect(payerLine({ payer: 'not-signed-in' }, t, false)).toBe('未登录');
    expect(payerLine({ payer: 'unknown', message: 'CODEX_HOME 指到了别处' }, t, true)).toBe('读不出:CODEX_HOME 指到了别处');
  });

  it('附注:接的是哪几家、套餐多旧、Claude 订阅登 Pi 扣额外用量', () => {
    expect(
      planNotes({ payer: 'subscription', via: ['Claude', 'ChatGPT'], planAsOf: 1, extraUsage: true }, t, () => '10-10 23:51')
    ).toEqual(['接的是 Claude · ChatGPT', '套餐信息记于 10-10 23:51', '扣的是 Claude 额外用量(另外计费),不占套餐额度']);
  });

  it('没登自己的账号:附注指去哪里登', () => {
    expect(planNotes({ payer: 'not-signed-in' }, t, () => '')).toEqual(['在资源库 → 智能体里登录。']);
    expect(planNotes({ payer: 'api-key' }, t, () => '')).toEqual([]);
  });

  it('资源库「账号」那一行带的套餐名:只在是订阅且读得出名字时', () => {
    expect(planLabel({ payer: 'subscription', plan: 'Claude Max 20x' }, t)).toBe('Claude Max 20x');
    expect(planLabel({ payer: 'subscription', plan: 'Google AI Ultra', tierUnknown: true }, t)).toBe('Google AI Ultra(档位读不出)');
    expect(planLabel({ payer: 'subscription' }, t)).toBeNull();
    expect(planLabel({ payer: 'api-key', plan: 'MiMo 按量付费' }, t)).toBeNull();
    expect(planLabel(undefined, t)).toBeNull();
  });

  it('窗口按长度起名，厂商的分组原样带上', () => {
    expect(windowLabel({ windowMinutes: 300, usedPercent: 1 }, t)).toBe('5 小时');
    expect(windowLabel({ windowMinutes: 10_080, group: 'Fable', usedPercent: 1 }, t)).toBe('每周 · Fable');
    expect(windowLabel({ monthly: true, group: 'chat', usedPercent: 1 }, t)).toBe('本月 · chat');
    expect(windowLabel({ windowMinutes: 1_440, usedPercent: 1 }, t)).toBe('1 天');
    expect(windowLabel({ usedPercent: 1 }, t)).toBe('额度');
  });

  it('用了多少:有次数给次数，否则百分比', () => {
    expect(usedText({ usedPercent: 0, used: 0, limit: 200, monthly: true }, t)).toBe('用了 0 / 200');
    expect(usedText({ usedPercent: 84 }, t)).toBe('用了 84%');
    expect(formatPercent(0.4)).toBe('0.4');
    expect(formatPercent(44.5)).toBe('45');
  });

  it('读不到的原因;没登录那句付钱行已经说了，不重复', () => {
    expect(unavailableText({ kind: 'unavailable', reason: 'not-read-yet', readAt: 0 }, t)).toBe(
      '还没查过。厂商限制了查询次数，点「现在查」才去问。'
    );
    expect(unavailableText({ kind: 'unavailable', reason: 'not-signed-in', readAt: 0 }, t)).toBeNull();
    expect(unavailableText({ kind: 'unavailable', reason: 'error', message: '超时', readAt: 0 }, t)).toBe('读不到:超时');
    expect(unavailableText({ kind: 'windows', windows: [{ usedPercent: 1 }], readAt: 0 }, t)).toBeNull();
  });
});


it('API connections explain the billing source instead of offering a subscription quota check', () => {
  const reading = { kind: 'unavailable' as const, reason: 'not-read-yet' as const, readAt: 1, onDemand: true };
  expect(quotaReading({ payer: 'api-key' }, reading)).toMatchObject({ reason: 'vendor-console' });
  expect(quotaReading({ payer: 'custom-endpoint' }, reading)).toMatchObject({ reason: 'custom-endpoint' });
  expect(quotaReading({ payer: 'subscription' }, reading)).toBe(reading);
});
