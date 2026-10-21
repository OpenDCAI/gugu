import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 表格车道 10-13 (packaged build): an App's program that starts a `worker_threads` worker — the spreadsheet's IronCalc
 * thread — never got it running. A worker inherits the program's `--import gugu-program.mjs` and ran it again; with no
 * `process.send` there it threw "gugu: this program was not started by gugu (it has no host channel)". The unit tests
 * never pass through that preload, so they stayed green. Here the program starts as main starts one
 * (extension-programs.ts): node, `--import` the runtime as the build bundles it (vite.config.mts), the IPC slot.
 */
let dir: string;
let runtime: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gugu-program-worker-'));
  runtime = join(dir, 'gugu-program.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./program-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: runtime,
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the program printed, started as main starts one: its own code after `--import` the runtime, IPC on the 4th slot. */
function runProgram(files: Record<string, string>): Promise<string> {
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  // The program's own environment, without the test runner's node options.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(runtime).href, join(dir, 'app.mjs')], {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
}

describe('an App program\'s worker threads', () => {
  it('a worker the program starts runs — as plain Node, without gugu; the main thread keeps gugu', async () => {
    const out = await runProgram({
      'app.mjs': [
        "import { Worker } from 'node:worker_threads'",
        'console.log(`main: ${typeof gugu}`)',
        "const worker = new Worker(new URL('./worker.mjs', import.meta.url))",
        "worker.once('message', (said) => { console.log(`worker ran: ${said}`); process.exit(0) })",
        "worker.once('error', (error) => { console.log(`worker failed: ${error.message}`); process.exit(1) })",
      ].join('\n'),
      'worker.mjs': [
        "import { parentPort } from 'node:worker_threads'",
        "parentPort.postMessage(typeof globalThis.gugu === 'undefined' ? 'no gugu' : 'gugu')",
      ].join('\n'),
    });
    expect(out).toBe('main: object\nworker ran: no gugu');
  }, 30_000);
});

describe('an App program that fails as it starts', () => {
  // 10-19 mac1: the Computer Use App's program, its client not installed, said why and set its exit code at once — and
  // kept running, held by gugu's channel listener, until gugu's initialize gave up after 60 s; every catalog call waited.
  it('exits by itself with what it said: the runtime does not keep it running', async () => {
    const out = await runProgram({
      'app.mjs': [
        "process.stderr.write('The client this program drives is not installed on this computer\\n')",
        'process.exitCode = 1',
      ].join('\n'),
    });
    expect(out).toBe('The client this program drives is not installed on this computer');
  }, 30_000);
});
