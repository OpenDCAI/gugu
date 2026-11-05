/**
 * Node-only process logging bootstrap.
 * Import from '@gugu/session-shared/logger/node' in Node deployments only.
 */

import type pinoLib from 'pino';
import { setRootLogger } from '../context';
import { installAsyncLogContext } from '../context-node';
import { createPinoLogger } from '../pino';
import type { LogFields, Logger } from '../types';
import { writeLogSync } from './write-log-sync';

export { writeLogSync } from './write-log-sync';

export type InitProcessLoggingOptions = {
  name: string;
  env?: NodeJS.ProcessEnv;
  bindings?: LogFields;
  destination?: pinoLib.DestinationStream;
  debugFlag?: boolean;
};

export function initProcessLogging(options: InitProcessLoggingOptions): Logger {
  const env = options.env ?? process.env;
  const logger = createPinoLogger({
    // 旧名 EMDASH_LOG_LEVEL 照认。
    envLevel: env.GUGU_SESSION_LOG_LEVEL ?? env.EMDASH_LOG_LEVEL ?? env.LOG_LEVEL,
    debugFlag: options.debugFlag,
    bindings: {
      proc: options.name,
      pid: process.pid,
      ...options.bindings,
    },
    destination: options.destination ?? parentStderrDestination(),
  });

  installAsyncLogContext();
  setRootLogger(logger);
  return logger;
}

function parentStderrDestination(): pinoLib.DestinationStream {
  let disconnected = false;
  const destination = {
    write(message: string): void {
      if (!disconnected) writeLogSync(2, message);
    },
    destroy(): void {
      // The synchronous writer has no queued stream to drain. Invalidate its
      // destination so shutdown logging cannot write to the parent's closed pipe.
      disconnected = true;
    },
  };
  process.once('disconnect', () => destination.destroy());
  // A fork can lose its parent while its modules are still being loaded.
  if (process.connected === false) destination.destroy();

  return destination;
}
