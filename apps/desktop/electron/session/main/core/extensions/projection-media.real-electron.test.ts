import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
const enabled = electron && process.env.GUGU_TEST_MEDIA_HELPER && process.env.GUGU_PROJECTION_FFMPEG && process.env.GUGU_TEST_CHROMIUM;
let temporary = '';
let result: { passed: boolean; reused: boolean; inputCalls: number; paints: unknown[];
  device: { signedInputs: number; paints: number; retargetClosed: boolean; privateKeysHidden: boolean;
    wrongVersionRefused: boolean; wrongSourceRefused: boolean };
  ownership: { lateHelperExited: boolean; concurrentNativeDecoders: number; reusedPerStream: boolean } };

// Real installed App grants, NativeImage, native H264 and browser paint/control.
// Only project lookup and unrelated process event buses are fixture adapters.
describe.skipIf(!enabled)('projection factory through real media with Electron', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-projection-pipeline-'));
    const repo = process.cwd();
    const stubs: Record<string, string> = {
      '@main/lib/logger': 'export const log={warn(){}}',
      '../sessions/session-events': 'export const sessionEvents={on(){}}',
      '../projects/project-events': 'export const projectEvents={on(){}}',
      './projection-task': 'export async function projectionTaskProject(){return "fixture-project"}',
      './app-programs-elsewhere': 'export function knownSessionMachine(){return undefined}',
    };
    const entry = path.join(repo, 'apps/desktop/electron/session/main/core/extensions/test-support/projection-media-electron.ts');
    const main = path.join(temporary, 'main.cjs');
    await build({ entryPoints: [entry], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [{
      name: 'pipeline-fixture-adapters', setup(builder) {
        builder.onResolve({ filter: /^@shared\// }, ({ path: imported }) => ({ path: path.join(repo, 'apps/desktop/src/session/shared', imported.slice(8) + '.ts') }));
        builder.onResolve({ filter: /.*/ }, ({ path: imported }) => stubs[imported] ? { path: imported, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: imported }) => ({ contents: stubs[imported] }));
      },
    }] });
    const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: path.join(temporary, 'user-data') };
    fs.mkdirSync(env.GUGU_HOME!, { recursive: true }); fs.mkdirSync(env.GUGU_USER_DATA_DIR!, { recursive: true });
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron!, [main], { env, signal: AbortSignal.timeout(45_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (process.env.GUGU_BROWSER_PROBE_REPORT_DIR) {
      fs.mkdirSync(process.env.GUGU_BROWSER_PROBE_REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GUGU_BROWSER_PROBE_REPORT_DIR, 'native-projection-pipeline.log'), stdout + '\n' + stderr);
    }
    expect(code, stdout + '\n' + stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('PROJECTION_PIPELINE_RESULT='));
    expect(line, stdout + '\n' + stderr).toBeDefined();
    const report = JSON.parse(line!.slice('PROJECTION_PIPELINE_RESULT='.length));
    expect(report.home).toBe(env.GUGU_HOME); expect(report.userData).toBe(env.GUGU_USER_DATA_DIR);
    result = report;
  }, 50_000);
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  it('decodes two correlated captures, reuses pixels, applies Unicode once, and drains on App revocation', () => {
    expect(result).toMatchObject({ passed: true, reused: true, inputCalls: 1 });
    expect(result.paints.length).toBeGreaterThanOrEqual(2);
    expect(result.ownership).toEqual({ lateHelperExited: true, concurrentNativeDecoders: 2, reusedPerStream: true });
    expect(result.device).toMatchObject({ signedInputs: 1, retargetClosed: true, privateKeysHidden: true,
      wrongVersionRefused: true, wrongSourceRefused: true });
    expect(result.device.paints).toBeGreaterThanOrEqual(2);
  });
});
