import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountApp } from '@shared/extensions/account-apps';
import { AccountAppsLocalRecord } from './account-apps-record';

let root: string;
const app = (): AccountApp => ({ id: 'browser-use', version: '1.0.0', digestAgreed: 'a'.repeat(64),
  grants: { capabilities: ['agents:tools'], network: [] }, autoUpdate: true });
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'gugu-account-apps-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('account Apps choices on this computer', () => {
  it('persists a successful approval for retry after a process restart', () => {
    new AccountAppsLocalRecord(root).approved('owner', app());
    expect(new AccountAppsLocalRecord(root).account('owner')).toEqual({ excluded: [], pending: [app()] });
  });
  it('keeps uninstall choices local and separated by account', () => {
    const one = new AccountAppsLocalRecord(root);
    one.approved('owner', app()); one.approved('other', app());
    one.exclude('owner', 'browser-use');
    expect(new AccountAppsLocalRecord(root).account('owner')).toEqual({ excluded: ['browser-use'], pending: [app()] });
    expect(one.account('other').pending).toEqual([app()]);
    expect(new AccountAppsLocalRecord(path.join(root, 'another-computer')).account('owner')).toEqual({ excluded: [], pending: [] });
  });
  it('clears only this account local exclusion after an explicit successful reinstall', () => {
    const record = new AccountAppsLocalRecord(root);
    record.exclude('owner', 'browser-use'); record.exclude('other', 'browser-use');
    record.approved('owner', app());
    expect(record.account('owner').excluded).toEqual([]);
    expect(record.account('other').excluded).toEqual(['browser-use']);
  });
  it('does not drop a newer local choice when an older cloud write completes', () => {
    const record = new AccountAppsLocalRecord(root);
    const newer = { ...app(), version: '2.0.0', digestAgreed: 'b'.repeat(64), autoUpdate: false };
    record.approved('owner', app()); record.approved('owner', newer); record.synced('owner', app());
    expect(record.account('owner').pending).toEqual([newer]);
    record.synced('owner', newer);
    expect(record.account('owner').pending).toEqual([]);
  });
  it('can roll back a failed synchronous uninstall without losing the queued approval', () => {
    const record = new AccountAppsLocalRecord(root); record.approved('owner', app());
    const previous = record.account('owner'); record.exclude('owner', 'browser-use'); record.restore('owner', previous);
    expect(record.account('owner')).toEqual({ excluded: [], pending: [app()] });
  });
  it('does not interpret corrupt files as permission to restore', () => {
    writeFileSync(path.join(root, 'account-apps.json'), '{broken');
    expect(() => new AccountAppsLocalRecord(root).account('owner')).toThrow();
    writeFileSync(path.join(root, 'account-apps.json'), JSON.stringify({ version: 2, accounts: {} }));
    expect(() => new AccountAppsLocalRecord(root).account('owner')).toThrow();
  });
  it('stores decisions without tokens and rejects recording non-allowlisted Apps', () => {
    const record = new AccountAppsLocalRecord(root); record.approved('owner', app());
    const raw = readFileSync(path.join(root, 'account-apps.json'), 'utf8');
    expect(JSON.parse(raw).accounts.owner.pending).toEqual([app()]);
    expect(raw).not.toContain('token');
    expect(() => record.approved('owner', { ...app(), id: 'another-app' })).toThrow('not enabled');
  });
});
