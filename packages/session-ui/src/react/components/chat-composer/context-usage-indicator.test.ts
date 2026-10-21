import { describe, expect, it } from 'vitest';
import { providerCostForRoute } from './context-usage-indicator';

describe('providerCostForRoute', () => {
  const cost = { amount: 0.42, currency: 'USD' };

  it('shows provider cost for an explicitly API-key session', () => {
    expect(providerCostForRoute({ cost, costSource: 'api-key' })).toEqual(cost);
  });

  it('hides provider currency for Gugu platform billing', () => {
    expect(providerCostForRoute({ cost, costSource: 'platform' })).toBeNull();
  });

  it('hides provider currency for a subscription session', () => {
    expect(providerCostForRoute({ cost, costSource: 'subscription' })).toBeNull();
  });

  it('hides provider currency when the billing route is unknown', () => {
    expect(providerCostForRoute({ cost, costSource: 'unknown' })).toBeNull();
  });
});
