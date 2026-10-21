import { ok } from '@gugu/session-shared';
import { appService } from '@main/core/app/service';
import { appSettingsService } from '@main/core/settings/settings-service';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { captureDeepSample } from './deep-sample';
import { hasResourceMonitorInternals, sampleOnce, setResourceMonitorOpen } from './resource-sampler';

export const resourceMonitorController = createRPCController({
  /** One-shot sample of current PTY resource usage. */
  getSnapshot: async () => {
    const { enabled } = await appSettingsService.get('resourceMonitor');
    if (!enabled) return ok(null);
    return ok(await sampleOnce());
  },

  setOpen: (clientId: string, subscriptionId: string, open: boolean, sequence: number, internals: boolean) => {
    setResourceMonitorOpen(clientId, subscriptionId, open, sequence, internals);
    return ok();
  },

  /** Record one memory dump of every process, then let the user save it as local JSON. Null when they cancel. */
  deepSample: async (dialogTitle: string) => {
    const { enabled } = await appSettingsService.get('resourceMonitor');
    if (!enabled || !hasResourceMonitorInternals()) throw new Error('deep sample needs the monitor page and its advanced diagnostics open');
    const content = await captureDeepSample(await sampleOnce());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = await appService.saveTextFile({ title: dialogTitle, defaultPath: `gugu-deep-sample-${stamp}.json`, content });
    return ok(path ?? null);
  },
});
