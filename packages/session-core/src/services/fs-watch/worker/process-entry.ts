import { initProcessLogging } from '@gugu/session-shared/logger/node';
import { withValidation } from '@gugu/session-wire/api';
import {
  serveWorkerProcess,
  workerValidatePolicy,
  type ProcessRuntimePort,
} from '@gugu/session-wire/util/process-runtime';
import { fsWatchContract } from '../api';
import { createFsWatchController } from '../impl/controller';

export type RunFsWatchWorkerProcessOptions = {
  env?: NodeJS.ProcessEnv;
  port?: ProcessRuntimePort;
  exit?: (code: number) => void;
};

export function runFsWatchWorkerProcess(options: RunFsWatchWorkerProcessOptions = {}): void {
  const env = options.env ?? process.env;
  const logger = initProcessLogging({ name: 'fs-watch-runtime', env });

  void serveWorkerProcess(
    (scope) =>
      withValidation(
        fsWatchContract,
        createFsWatchController({
          scope: scope.child('fs-watch-runtime'),
          onError: (context, error) => logger.warn(context, { error }),
        }),
        workerValidatePolicy(env)
      ),
    { port: options.port, exit: options.exit, logger, failOnCleanupError: true }
  );
}
