import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createProjectionHostIdentity } from './projection-host-identity';
import { createProjectionDeviceClient, type ProjectionViewerPage } from './projection-device-client';
import type { DeviceRpcPipe, DeviceRpcPipeHandlers } from '@gugu/core/cloud/deviceRpcRequester';

/** Outer host owns login/runtime events and observes asynchronous responder disposal. */
export function createProjectionDeviceRuntime(input: Parameters<typeof createProjectionHostIdentity>[0] & {
  resources(): string;
  report(error: unknown): void;
  capturePage(webContentsId: number): Promise<ProjectionViewerPage>;
  openPipe(deviceId: string, asker: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe>;
}) {
  const identity = createProjectionHostIdentity(input);
  const active = new Set<() => Promise<void>>(), draining = new Set<Promise<void>>();
  const report = (error: unknown) => {
    try { input.report(error); }
    catch { process.stderr.write(`Projection device cleanup failed: ${String(error).slice(0, 1000)}\n`); }
  };
  let stopped = false;
  let openingViewers = 0;
  const track = <T extends { dispose(): Promise<void> | void }>(host: T): T => {
    if (stopped) throw new Error('Projection device runtime stopped');
    let pending: Promise<void> | undefined;
    const dispose = () => {
      if (pending) return pending;
      active.delete(dispose);
      pending = Promise.resolve().then(() => host.dispose()).finally(() => { draining.delete(pending!); });
      draining.add(pending); void pending.catch(report); return pending;
    };
    active.add(dispose);
    return { ...host, dispose };
  };
  return {
    invalidate: identity.invalidate,
    options: {
      identity, report,
      executables() {
        const resources = input.resources();
        if (!resources) throw new Error('Projection media binaries are not installed in this host');
        const root = join(resources, 'projection-media');
        const executable = join(root, process.platform === 'win32' ? 'gugu-projection-media.exe' : 'gugu-projection-media');
        const ffmpeg = join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        try { accessSync(executable, constants.X_OK); accessSync(ffmpeg, constants.X_OK); }
        catch { throw new Error('Projection media binaries are not installed in this host'); }
        return { executable, ffmpeg };
      },
    },
    track,
    /** Host-only entry, intentionally not registered as an App/preload verb yet. */
    async openViewer(webContentsId: number) {
      if (stopped || active.size + openingViewers >= 128) throw new Error('Projection viewer runtime is unavailable');
      openingViewers++;
      try {
        const page = await input.capturePage(webContentsId);
        if (stopped) { page.release(); throw new Error('Projection device runtime stopped'); }
        const client = await createProjectionDeviceClient({ page, identity, openPipe: input.openPipe, report });
        if (stopped) { await client.close(); throw new Error('Projection device runtime stopped'); }
        const owned = track({ dispose: client.close });
        client.signal.addEventListener('abort', () => { void owned.dispose(); }, { once: true });
        if (client.signal.aborted) void owned.dispose();
        return Object.freeze({ ...client, close: owned.dispose });
      } finally { openingViewers--; }
    },
    async dispose() {
      stopped = true; identity.dispose();
      const results = await Promise.allSettled([...active].map(close => close()));
      const rest = await Promise.allSettled([...draining]);
      const failure = [...results, ...rest].find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}
