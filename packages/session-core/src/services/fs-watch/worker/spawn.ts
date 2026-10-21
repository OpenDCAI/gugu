import type { ProcessHost } from '@gugu/session-wire/process';
import type { Scope } from '@gugu/session-wire/util';
import type { IWatchService } from '../api';
import { processWatchBackend } from '../impl/process-backend';
import { createWatchService } from '../impl/watch-service';

export type SpawnFsWatchWorkerOptions = {
  entry: string;
  scope?: Scope;
  host?: ProcessHost;
  env?: Record<string, string | undefined>;
  onError?: (context: string, error: unknown) => void;
};

export function spawnFsWatchWorker(options: SpawnFsWatchWorkerOptions): IWatchService {
  return createWatchService({
    backend: processWatchBackend({
      entry: options.entry,
      scope: options.scope,
      host: options.host,
      env: options.env,
      shutdownGraceMs: 6_000,
      onError: options.onError,
    }),
    scope: options.scope,
    graceMs: 2_500,
    onError: options.onError,
  });
}
