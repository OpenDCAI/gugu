import type { LocalUsageRequest, LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { buildLocalUsageSnapshot } from './build-local-usage-snapshot';
import { validateLocalUsageRequest } from './validate-request';

/**
 * 用量页(product spec,#6334)的本机数据口:`usage.localDaily({from, to})`。
 * 渲染层 `window.electronAPI.invoke('usage.localDaily', {from, to})` 直接拿到 {@link LocalUsageSnapshot}
 * (❌ 不包 Result 信封);范围不合法与读库/读盘失败一律抛,invoke 的 promise 以此 reject。
 */
export const usageController = createRPCController({
  localDaily: async (request: LocalUsageRequest): Promise<LocalUsageSnapshot> => {
    const invalid = validateLocalUsageRequest(request);
    if (invalid) throw new Error(`usage.localDaily: ${invalid}`);
    return buildLocalUsageSnapshot({ from: request.from, to: request.to });
  },
});
