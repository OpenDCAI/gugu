import { useQuery } from '@tanstack/react-query';
import type { SubscriptionPlanReading, SubscriptionUsageReading } from '@gugu/session-core/agents/plugins';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';

/**
 * 套餐与用量读数的 react-query 键与取法 —— 「订阅」页与资源库「账号」那一行共用同一把键，
 * 两处显示的就是同一份读数(product spec「在哪」),❌ 各问各的。
 */

export const SUBSCRIPTION_STALE_MS = 30_000;

export function subscriptionKey(machine: string | null, agentId?: string, part?: 'plan' | 'usage', connectionId?: string) {
  return ['subscriptions', machine ?? 'local', ...(agentId ? [agentId] : []), ...(part ? [part] : []), ...(connectionId ? [connectionId] : [])];
}

export async function readPlan(machine: string | null, providerId: string, connectionId?: string): Promise<SubscriptionPlanReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscription({ providerId, connectionId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

export async function readUsage(machine: string | null, providerId: string, force: boolean, connectionId?: string): Promise<SubscriptionUsageReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscriptionUsage({ providerId, force, connectionId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

export function useSubscriptionPlan(machine: string | null, agentId: string, connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: subscriptionKey(machine, agentId, 'plan', connectionId),
    queryFn: () => readPlan(machine, agentId, connectionId),
    staleTime: SUBSCRIPTION_STALE_MS,
    retry: false,
    enabled,
  });
}

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}
