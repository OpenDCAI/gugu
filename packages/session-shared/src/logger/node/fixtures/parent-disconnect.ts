import { initProcessLogging } from '../index';

const mode = process.argv[2];
const late = mode === 'late';
let logger = late ? undefined : initProcessLogging({ name: 'parent-disconnect-test' });

function finish(): void {
  logger ??= initProcessLogging({ name: 'parent-disconnect-test' });
  if (mode !== 'backlog') {
    // Two writes leave a queued buffer behind an asynchronous write. A single
    // write does not exercise SonicBoom's synchronous exit-time flush loop.
    logger.warn('first shutdown warning');
    logger.warn('second shutdown warning');
  }
  process.exit(0);
}

process.once('disconnect', finish);
process.once('message', () => {
  if (mode !== 'backlog') return finish();
  // The parent pauses its pipe reader first. Four MiB cannot drain into that
  // pipe before disconnection, so these records are already queued at that point.
  const padding = 'x'.repeat(16 * 1024);
  for (let i = 0; i < 256; i++) logger!.warn('warning queued before disconnect', { padding });
  process.send?.('queued');
});
process.send?.('ready');
