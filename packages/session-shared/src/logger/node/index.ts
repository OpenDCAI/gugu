/**
 * Node-only process logging bootstrap.
 * Import from '@gugu/session-shared/logger/node' in Node deployments only.
 */

import pinoLib from 'pino';
import { setRootLogger } from '../context';
import { installAsyncLogContext } from '../context-node';
import { createPinoLogger } from '../pino';
import type { LogFields, Logger } from '../types';

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
  const destination = pinoLib.destination(2);
  let disconnected = false;
  const disconnect = (): void => {
    disconnected = true;
    // The parent owns this pipe's reader. SonicBoom's exit-time flush can retry
    // a permanent EPIPE forever, preventing process.exit from terminating the worker.
    destination.destroy();
  };
  process.once('disconnect', disconnect);
  // A fork can lose its parent while its modules are still being loaded.
  if (process.connected === false) disconnect();

  return {
    write(message: string): void {
      if (!disconnected) destination.write(message);
    },
  };
}
