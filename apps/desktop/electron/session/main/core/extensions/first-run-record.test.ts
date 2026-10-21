import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

const { FIRST_RUN_RECORD_FILE, noteFirstRunProfile, readFirstRunRecord, writeFirstRunRecord } = await import('./first-run-record');

// 161 10-15: whether this profile is a new one can be told only at the very start of a start, before anything makes the
// Apps' folder (`task-extensions/`) — a profile that has one has been in use (an old profile upgraded: nothing put in).
let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-first-run-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('the first-run record on this computer', () => {
  it('a new profile: pending, written down', () => {
    expect(noteFirstRunProfile(userData)).toEqual({ state: 'pending' });
    expect(readFirstRunRecord(userData)).toEqual({ state: 'pending' });
  });

  it('a profile with Apps on record already (an old one upgraded): existing — nothing put in', () => {
    fs.mkdirSync(path.join(userData, 'task-extensions'));
    expect(noteFirstRunProfile(userData)).toEqual({ state: 'existing' });
  });

  it('what is on record is kept: the Apps folder made since does not turn a pending profile into an old one', () => {
    noteFirstRunProfile(userData);
    fs.mkdirSync(path.join(userData, 'task-extensions'));
    expect(noteFirstRunProfile(userData)).toEqual({ state: 'pending' });
    writeFirstRunRecord(userData, { state: 'pending', apps: ['office'], installed: [] });
    expect(noteFirstRunProfile(userData)).toEqual({ state: 'pending', apps: ['office'], installed: [] });
    writeFirstRunRecord(userData, { state: 'done', at: '2026-10-16T12:00:00Z' });
    expect(noteFirstRunProfile(userData)).toEqual({ state: 'done', at: '2026-10-16T12:00:00Z' });
  });

  it('a record of another shape is refused when written, and said as it is when read — never read as a new profile', () => {
    expect(() => writeFirstRunRecord(userData, { state: 'maybe' })).toThrow();
    fs.writeFileSync(path.join(userData, FIRST_RUN_RECORD_FILE), JSON.stringify({ state: 'agreed' }));
    expect(() => readFirstRunRecord(userData)).toThrow(/malformed/);
  });
});
