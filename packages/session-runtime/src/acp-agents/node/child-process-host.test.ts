import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChildAcpProcessHost } from './child-process-host';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ACP worker process transport', () => {
  for (const method of ['spawn', 'spawnTerminal'] as const) {
    it.runIf(process.platform === 'win32')(`${method} stops the engine below a .cmd wrapper`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'gugu acp cleanup '));
      directories.push(cwd);
      await writeFile(join(cwd, 'engine.cjs'), 'console.log(process.pid);setInterval(()=>{},1000)');
      const command = join(cwd, 'engine.cmd');
      await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0engine.cjs" %*\r\n`);
      const child = await new ChildAcpProcessHost()[method]({ command, args: [], cwd, env: { ...process.env } as Record<string, string> });
      const pid = await new Promise<number>((resolve, reject) => {
        child.onError(reject);
        child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
      try {
        child.kill('SIGKILL');
        await expect.poll(() => {
          try { process.kill(pid, 0); return true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
            throw error;
          }
        }).toBe(false);
      } finally {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
    });
    it(`${method} preserves argv and piped output through the platform launcher`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'gugu acp launcher '));
      directories.push(cwd);
      const script = join(cwd, 'echo.cjs');
      await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const expected = ['acp', 'a path with spaces', 'model="中文 & value"'];
      let command = process.execPath;
      let args = [script, ...expected];
      if (process.platform === 'win32') {
        command = join(cwd, 'agent.cmd');
        await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
        args = expected;
      }
      const host = new ChildAcpProcessHost();
      const child = await host[method]({ command, args, cwd, env: { ...process.env } as Record<string, string> });
      const chunks: Buffer[] = [];
      const output = await new Promise<string>((resolve, reject) => {
        child.onError(reject);
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stdout.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      expect(JSON.parse(output)).toEqual(expected);
    });
  }
});
