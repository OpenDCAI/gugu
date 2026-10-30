import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
let temporary = '';
let cases: Record<string, { passed: boolean; error?: string }>;

// Native codec only: no BrowserWindow, login, model, or native addon rebuild.
describe.skipIf(!electron)('projection video pixels with real Electron', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-projection-image-'));
    const entry = path.join(process.cwd(), 'apps/desktop/electron/session/main/core/extensions/test-support/projection-image-electron.ts');
    const main = path.join(temporary, 'main.cjs');
    await build({ entryPoints: [entry], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: path.join(temporary, 'user-data') };
    fs.mkdirSync(env.GUGU_HOME!, { recursive: true }); fs.mkdirSync(env.GUGU_USER_DATA_DIR!, { recursive: true });
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron!, [main], { env, signal: AbortSignal.timeout(10_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code, stdout + '\n' + stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('PROJECTION_IMAGE_RESULT='));
    expect(line, stdout + '\n' + stderr).toBeDefined();
    const report = JSON.parse(line!.slice('PROJECTION_IMAGE_RESULT='.length));
    expect(report.home).toBe(env.GUGU_HOME); expect(report.userData).toBe(env.GUGU_USER_DATA_DIR);
    cases = report.cases;
  }, 15_000);
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  it.each(['native-channel-alpha-and-size', 'native-explicit-video-matte', 'native-cancellation', 'native-invalid-source', 'native-pixel-lease-reuse'])('%s', name => {
    expect(cases[name], JSON.stringify(cases[name])).toEqual({ passed: true });
  });
});
