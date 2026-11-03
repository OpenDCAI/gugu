import { initProcessLogging } from '../index';

const late = process.argv[2] === 'late';
let logger = late ? undefined : initProcessLogging({ name: 'parent-disconnect-test' });

function finish(): void {
  logger ??= initProcessLogging({ name: 'parent-disconnect-test' });
  // Two writes leave a queued buffer behind an asynchronous write. A single
  // write does not exercise SonicBoom's synchronous exit-time flush loop.
  logger.warn('first shutdown warning');
  logger.warn('second shutdown warning');
  process.exit(0);
}

process.once('disconnect', finish);
process.once('message', finish);
process.send?.('ready');
