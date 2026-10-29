import { expect, it } from 'vitest';
import { openExtensionProgramAccess, revokeExtensionProgramAccess, withExtensionProgramAccess } from './extension-program-access';

it('single-call cancellation waits for its authority cleanup before answering the caller', async () => {
  const parent = new AbortController();
  const cleanup = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let outcome = 'pending';
  const call = withExtensionProgramAccess('cleanup-app', parent.signal, async (signal) => {
    try {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      });
    } finally { await cleanup.promise; }
  }).then(() => { outcome = 'completed'; }, () => { outcome = 'interrupted'; });
  try {
    await entered.promise;
    parent.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(outcome).toBe('pending');
  } finally {
    cleanup.resolve();
    await call;
  }
  expect(outcome).toBe('interrupted');
});

it('a late resource release cannot detach the re-enabled App from the next revocation', () => {
  const old = openExtensionProgramAccess('resource-app');
  revokeExtensionProgramAccess('resource-app');
  expect(old.signal.aborted).toBe(true);
  const current = openExtensionProgramAccess('resource-app');
  const other = openExtensionProgramAccess('other-resource-app');
  try {
    old.release();
    revokeExtensionProgramAccess('resource-app');
    expect(current.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  } finally {
    current.release();
    other.release();
  }
});

it('a single resource cancellation does not revoke other resources of the App', () => {
  const parent = new AbortController();
  const one = openExtensionProgramAccess('resource-caller', parent.signal);
  const two = openExtensionProgramAccess('resource-caller');
  try {
    parent.abort();
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(false);
    one.release();
    revokeExtensionProgramAccess('resource-caller');
    expect(two.signal.aborted).toBe(true);
  } finally {
    one.release();
    two.release();
  }
});
