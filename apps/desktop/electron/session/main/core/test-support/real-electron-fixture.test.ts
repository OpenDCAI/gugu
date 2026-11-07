import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec';
import { startRealElectronFixture } from './real-electron-fixture';

vi.mock('@gugu/session-core/exec', () => ({ spawnOwnedChild: vi.fn() }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function processDouble() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  const drained = deferred();
  let physicallyStopped = false;
  const stop = vi.fn(async () => {
    await drained.promise;
    physicallyStopped = true;
    if (child.exitCode === null) child.signalCode = 'SIGTERM';
    child.stdout.end(); child.stderr.end();
    child.emit('exit', child.exitCode, child.signalCode); child.emit('close', child.exitCode, child.signalCode);
  });
  const owned = { child: child as unknown as ChildProcess, stop, kill: vi.fn() } as OwnedChild;
  vi.mocked(spawnOwnedChild).mockImplementation((_command, _args, options) => {
    child.on('error', options.onError);
    // Reproduce Node's original signal option: an error rejects immediately,
    // independently of when the owned tree and stdio actually finish closing.
    options.signal?.addEventListener('abort', () => child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
    return owned;
  });
  return { child, owned, stop, drained, physicallyStopped: () => physicallyStopped };
}

let temporary = '';
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-electron-lifecycle-unit-')); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnOwnedChild).mockReset(); fs.rmSync(temporary, { recursive: true, force: true }); });

function options(signal?: AbortSignal) {
  return { name: 'native-projection-pipeline', executable: '/fixture/Electron', args: ['/fixture/main.cjs'], signal,
    env: { GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: path.join(temporary, 'user-data') },
    reportDirectory: path.join(temporary, 'reports') };
}

describe('real Electron fixture ownership', () => {
  it('does not release its caller or profile on abort before physical tree shutdown', async () => {
    const fake = processDouble(), cancelled = new AbortController();
    const profile = path.join(temporary, 'user-data'); fs.mkdirSync(profile);
    const fixture = startRealElectronFixture(options(cancelled.signal));
    let settled = false;
    const result = fixture.result.catch(error => error).finally(() => { settled = true; });
    cancelled.abort(new Error('fixture child deadline'));
    try {
      await Promise.resolve();
      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      fs.writeFileSync(path.join(profile, 'still-owned'), 'writer has not exited');
      expect(fake.physicallyStopped()).toBe(false);
      fake.drained.resolve();
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(fake.physicallyStopped()).toBe(true);
      await fixture.dispose();
      fs.rmSync(profile, { recursive: true });
      expect(fs.existsSync(profile)).toBe(false);
    } finally { fake.drained.resolve(); await fixture.dispose(); await result; }
  });

  it('keeps the inner failure and late stderr when the parent deadline fires during teardown', async () => {
    const fake = processDouble(), cancelled = new AbortController();
    const fixture = startRealElectronFixture(options(cancelled.signal));
    const result = fixture.result.catch(error => error);
    fake.child.stderr.write('REAL_ELECTRON_FIXTURE_FAILURE=' + JSON.stringify({ phase: 'first-paint', message: 'Pipeline timed out', stack: 'original pipeline stack' }) + '\n');
    cancelled.abort(new Error('outer deadline'));
    try {
      fake.child.stderr.write('cleanup diagnostic after cancellation\n');
      fake.drained.resolve();
      const error = await result;
      expect(error.message).toContain('Pipeline timed out');
      expect(error.message).toContain('cleanup diagnostic after cancellation');
      expect(error.diagnostics).toMatchObject({ name: 'native-projection-pipeline', executable: '/fixture/Electron', args: ['/fixture/main.cjs'],
        primaryFailure: { phase: 'first-paint', message: 'Pipeline timed out' }, signal: 'SIGTERM', termination: { abort: { message: 'outer deadline' } } });
      const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'reports/native-projection-pipeline.json'), 'utf8'));
      expect(saved.stderr).toContain('cleanup diagnostic after cancellation');
      expect(saved.primaryFailure.message).toBe('Pipeline timed out');
    } finally { fake.drained.resolve(); await fixture.dispose(); await result; }
  });

  it('retains output on process error and waits for close instead of rejecting on the error event', async () => {
    const fake = processDouble();
    const fixture = startRealElectronFixture(options());
    let settled = false;
    const result = fixture.result.catch(error => error).finally(() => { settled = true; });
    fake.child.stdout.write('last stdout\n');
    fake.child.emit('error', Object.assign(new Error('spawn denied'), { code: 'EACCES' }));
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(fake.stop).toHaveBeenCalledTimes(1);
      fake.child.stderr.write('last stderr before physical close\n');
      fake.drained.resolve();
      const error = await result;
      expect(error.diagnostics).toMatchObject({ stdout: 'last stdout\n', stderr: 'last stderr before physical close\n', processError: { message: 'spawn denied', code: 'EACCES' } });
    } finally { fake.drained.resolve(); await fixture.dispose(); await result; }
  });

  it('drains descendants on root exit even when their inherited stdio keeps close pending', async () => {
    const fake = processDouble();
    const fixture = startRealElectronFixture(options());
    const result = fixture.result.catch(error => error);
    fake.child.exitCode = 0;
    fake.child.emit('exit', 0, null);
    try {
      await Promise.resolve();
      expect(fake.stop).toHaveBeenCalledTimes(1);
      fake.child.stderr.write('last descendant output before close\n');
      fake.drained.resolve();
      expect(await result).toMatchObject({ code: 0, stderr: 'last descendant output before close\n' });
      expect(fake.physicallyStopped()).toBe(true);
    } finally { fake.drained.resolve(); await fixture.dispose(); await result; }
  });

  it('does not authorize profile deletion when owned shutdown fails', async () => {
    const fake = processDouble(), cancelled = new AbortController();
    const profile = path.join(temporary, 'user-data'); fs.mkdirSync(profile);
    fake.stop.mockRejectedValue(new Error('owned process group still running'));
    const fixture = startRealElectronFixture(options(cancelled.signal));
    const result = fixture.result.catch(error => error);
    cancelled.abort(new Error('outer deadline'));
    await expect(fixture.dispose()).rejects.toThrow('owned process group still running');
    expect(fs.existsSync(profile)).toBe(true);
    // Finish the fake's stream lifecycle so a failing assertion cannot leave
    // this test's bookkeeping pending after it has already detected the defect.
    fake.child.exitCode = 1; fake.child.stdout.end(); fake.child.stderr.end(); fake.child.emit('close', 1, null);
    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.diagnostics.termination.shutdown).toMatchObject({ message: 'owned process group still running' });
  });
});
