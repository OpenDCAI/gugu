/** @jsxImportSource solid-js */
import { expect, it, vi } from 'vitest';
import type { TurnOutcomeItem } from '@session-chat/model';
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def';
import { isCreditExhaustion } from '@session-chat/components/rows/turn-outcome/credit-exhaustion';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

const said = '咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。';
const item: TurnOutcomeItem = { kind: 'turn-outcome', id: 'credit-turn:outcome', turnId: 'credit-turn', prompt: 'hello',
  outcome: { kind: 'error', reason: 'prompt_failed', said, detail: `{"error":{"message":"${said}","code":"credits_exhausted"}}\ncode=-32603` } };

it.each([288, 328, 360, 390, 800])('uses one ordinary body row with a working recharge link at %spx', async width => {
  const recharge = vi.fn();
  const result = await renderAndMeasureUnit(turnOutcomeUnitDef, item, makeContractCtx({ width }), host => {
    expect(host.querySelectorAll('[data-credit-exhausted]')).toHaveLength(1);
    expect(host.textContent?.replace(/\s+/g, ' ')).toBe('You’re out of credits. Top up to continue.');
    expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(host.textContent).not.toContain(said);
    expect(host.querySelector('[role="alert"], [data-slot="turn-outcome-badge"], [data-slot="turn-outcome-rule"]')).toBeNull();
    host.querySelector<HTMLAnchorElement>('[data-slot="credit-recharge"]')!.click();
    expect(recharge).toHaveBeenCalledOnce();
    expect(host.scrollWidth).toBeLessThanOrEqual(width);
    return {};
  }, { onRechargeCredits: recharge });
  expect(result.dom).toBe(result.computed);
});

it('requires an authoritative gateway refusal, rather than the balance or another provider’s quota failure', () => {
  expect(isCreditExhaustion(item.outcome)).toBe(true);
  expect(isCreditExhaustion({ kind: 'done' })).toBe(false);
  expect(isCreditExhaustion({ kind: 'error', reason: 'prompt_failed', said: 'Weekly usage limit reached' })).toBe(false);
  expect(isCreditExhaustion({ kind: 'error', detail: '{"error":{"code":"credits_exhausted","message":"Provider credits exhausted"}}' })).toBe(false);
  expect(isCreditExhaustion({ kind: 'error', signInRequired: true, said })).toBe(false);
  expect(isCreditExhaustion({ kind: 'error', said: '这个账号还没有咕咕积分。充值或开通会员后再发一次。', detail: '{"error":{"code":"no_credits","message":"这个账号还没有咕咕积分。"}}' })).toBe(false);
});

it.each([true, false])('renders the shared Pi reader outcome without exposing raw error text (credit=%s)', async exhausted => {
  const projected: TurnOutcomeItem = { ...item, outcome: { kind: 'error', reason: 'prompt_failed', ...(exhausted ? {
    detail: '{"error":{"code":"credits_exhausted","message":"Gugu credits"}}',
  } : {}) } };
  await renderAndMeasureUnit(turnOutcomeUnitDef, projected, makeContractCtx({ width: 328 }), host => {
    expect(host.querySelectorAll('[data-credit-exhausted]')).toHaveLength(exhausted ? 1 : 0);
    expect(host.textContent?.includes('You’re out of credits. Top up to continue.')).toBe(exhausted);
    expect(host.querySelectorAll('a')).toHaveLength(exhausted ? 1 : 0);
    expect(host.textContent).not.toContain('Gugu credits');
    if (!exhausted) expect(host.querySelector('[data-slot="turn-outcome-badge"]')).not.toBeNull();
    return {};
  }, { onRechargeCredits: vi.fn() });
});

it('does not invent a recharge button when the host did not connect that action', async () => {
  await renderAndMeasureUnit(turnOutcomeUnitDef, item, makeContractCtx({ width: 360 }), host => {
    expect(host.querySelector('a, button')).toBeNull();
    expect(host.textContent).toBe('You’re out of credits. Top up to continue.');
    return {};
  });
});
