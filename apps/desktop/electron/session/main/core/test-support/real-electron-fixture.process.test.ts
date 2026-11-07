import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { awaitFact } from '../../../../../../../tests/support/awaitFact';
import { startRealElectronFixture } from './real-electron-fixture';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

// PPID 1 and POSIX process-group ownership are the real failure witnessed in
// #1863. The shared OwnedChild Windows contract has its own platform tests.
describe.skipIf(process.platform === 'win32')('real fixture subprocess ownership', () => {
  it('reaps a real grandchild before its caller can delete the writing profile', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-fixture-tree-'));
    const profile = path.join(temporary, 'profile'), ready = path.join(temporary, 'grandchild.json');
    const parentInfo = path.join(temporary, 'parent.json');
    const writer = path.join(temporary, 'writer.cjs'), entry = path.join(temporary, 'main.cjs');
    fs.mkdirSync(profile);
    fs.writeFileSync(writer, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,parent:process.ppid}));
setInterval(() => fs.appendFileSync(${JSON.stringify(path.join(profile, 'active-writes'))}, 'x'), 20);
`);
    fs.writeFileSync(entry, `const fs = require('node:fs'), {spawn} = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(writer)}], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(parentInfo)}, JSON.stringify({pid:process.pid,child:child.pid}));
process.stderr.write('REAL_ELECTRON_FIXTURE_FAILURE=' + JSON.stringify({phase:'first-paint',message:'Pipeline timed out'}) + '\\n');
setInterval(() => {}, 1000);
`);
    const cancelled = new AbortController();
    const fixture = startRealElectronFixture({ name: 'owned-process-tree', executable: process.execPath, args: [entry],
      env: { ...process.env, GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: profile }, signal: cancelled.signal,
      reportDirectory: path.join(temporary, 'reports') });
    let completed = false;
    const result = fixture.result.catch(error => error).finally(() => { completed = true; });
    let pids: number[] = [];
    try {
      const child = await awaitFact('the real grandchild has started writing in the isolated profile', () => {
        if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8')) as {pid:number;parent:number};
        if (completed) throw new Error('fixture exited before creating its grandchild');
        return undefined;
      });
      const parent = JSON.parse(fs.readFileSync(parentInfo, 'utf8')) as {pid:number;child:number};
      pids = [parent.pid, child.pid];
      expect(child.parent).toBe(parent.pid);
      expect(parent.child).toBe(child.pid);
      expect(alive(child.pid)).toBe(true);
      cancelled.abort(new Error('whole-child deadline'));
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(alive(child.pid)).toBe(false);
      expect(alive(parent.pid)).toBe(false);
      expect(error.message).toContain('Pipeline timed out');
      await fixture.dispose();
      fs.rmSync(profile, { recursive: true });
      expect(fs.existsSync(profile)).toBe(false);
      const report = JSON.parse(fs.readFileSync(path.join(temporary, 'reports/owned-process-tree.json'), 'utf8'));
      expect(report.primaryFailure).toMatchObject({ phase: 'first-paint', message: 'Pipeline timed out' });
    } finally {
      cancelled.abort(new Error('test finished'));
      await fixture.dispose().catch(() => {});
      // This also contains the deliberate RED baseline: only the exact PIDs
      // written by our just-launched fixture may be signalled in test cleanup.
      const remaining = pids.filter(alive);
      if (remaining.length) {
        execFileSync('pgrep', ['-af', temporary], { encoding: 'utf8' });
        for (const pid of remaining) if (alive(pid)) process.kill(pid, 'SIGTERM');
        await awaitFact('the test-owned RED-baseline processes have exited', () => pids.every(pid => !alive(pid)) ? true : undefined);
      }
      await result;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
