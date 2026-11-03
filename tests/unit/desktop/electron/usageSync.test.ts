import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usageSyncStateStore } from '../../../../apps/desktop/electron/server/usage-sync';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-sync-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('usageSyncStateStore', () => {
  it('读不出来的水位按空水位来,不让同步永久停摆', () => {
    writeFileSync(join(dir, 'usage-sync.json'), '{"key":');
    expect(usageSyncStateStore(dir).readState('acct')).toEqual({});
    writeFileSync(join(dir, 'usage-sync.json'), 'null');
    expect(usageSyncStateStore(dir).readState('acct')).toEqual({});
  });

  it('写进去的水位按账号读回来,换账号就是空水位', () => {
    const store = usageSyncStateStore(dir);
    store.writeState('acct', { lastAt: 7 });
    expect(store.readState('acct')).toEqual({ lastAt: 7 });
    expect(store.readState('other')).toEqual({});
  });
});
