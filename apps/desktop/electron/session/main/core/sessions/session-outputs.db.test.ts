import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { forgetSessionOutputs, recordSessionOutput, sessionOpenedFile, sessionOutputs } from './session-outputs';

describe('session outputs (the host record)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('keeps the latest first, one row per target, per session', async () => {
    // Fired without awaiting in between: two opens arriving back to back must not overwrite each other.
    void recordSessionOutput('s1', { kind: 'file', path: '/repo/report.md' });
    void recordSessionOutput('s1', { kind: 'page', url: 'http://localhost:5173/' });
    void recordSessionOutput('s2', { kind: 'file', path: '/repo/other.md' });
    await recordSessionOutput('s1', { kind: 'file', path: '/repo/report.md' });

    expect(await sessionOutputs('s1')).toEqual([
      { kind: 'file', path: '/repo/report.md' },
      { kind: 'page', url: 'http://localhost:5173/' },
    ]);
    expect(await sessionOutputs('s2')).toEqual([{ kind: 'file', path: '/repo/other.md' }]);
  });

  it('keeps the latest 50', async () => {
    for (let i = 0; i <= 50; i++) void recordSessionOutput('s1', { kind: 'file', path: `/repo/${i}.md` });
    const list = await sessionOutputs('s1');
    expect(list).toHaveLength(50);
    expect(list[0]).toEqual({ kind: 'file', path: '/repo/50.md' });
    expect(list[49]).toEqual({ kind: 'file', path: '/repo/1.md' });
  });

  it('answers "was this file opened" from the record, by path or file:// page, whatever the harness', async () => {
    await recordSessionOutput('pty-session', { kind: 'file', path: '/repo/report.md' });
    await recordSessionOutput('pty-session', { kind: 'page', url: 'file:///repo/page.html' });

    expect(await sessionOpenedFile('pty-session', '/repo/report.md')).toBe(true);
    expect(await sessionOpenedFile('pty-session', '/repo/page.html')).toBe(true);
    expect(await sessionOpenedFile('pty-session', '/repo/secret.md')).toBe(false);
    expect(await sessionOpenedFile('another-session', '/repo/report.md')).toBe(false);
  });

  it('is forgotten with the session', async () => {
    await recordSessionOutput('s1', { kind: 'file', path: '/repo/report.md' });
    await forgetSessionOutputs('s1');
    expect(await sessionOutputs('s1')).toEqual([]);
  });
});
