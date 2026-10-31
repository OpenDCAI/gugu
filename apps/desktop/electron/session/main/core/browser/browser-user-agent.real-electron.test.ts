import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Requires a desktop/Xvfb. This exercises Electron's native navigation state,
// which a mocked WebContents or a browser opened after its first load cannot test.
// GUGU_BROWSER_REAL_ELECTRON=<electron executable> pnpm exec vitest run --project session-main <this file>
const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
const repo = process.cwd();
let temporary = '';

type Probe = {
  clean: string;
  profileAgent: string;
  contentsAgent: string;
  fallback: string;
  initialDocumentAgent: string;
  documentAgents: string[];
  requests: Array<{ url: string; userAgent: string }>;
};

describe.skipIf(!electron)('browser UA during native-to-CDP navigation handoff', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-ua-race-'));
    fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
      name: 'gugu-beta', productName: '咕咕 Beta', version: '0.2.58', main: 'main.cjs',
    }));
    // Only unrelated application services are stubbed. Electron, Chromium,
    // the application bootstrap, pane transport and Playwright are real.
    const stubs: Record<string, string> = {
      '@main/lib/events': 'export const events = { emit() {} }',
      '@main/lib/logger': 'export const log = { info() {}, warn() {}, error() {}, debug() {} }',
      '@main/core/extensions/extension-agent-context': 'export async function agentSessionContext() { return null }',
      '@main/core/sessions/session-orchestration': 'export async function openAgentBrowserPane() {}',
      './browser-webcontents-registry': 'export const browserWebContentsRegistry = { setMouseDownObserver() {}, browsersOfSession() { return [] } }',
    };
    await build({
      entryPoints: [path.join(repo, 'apps/desktop/electron/session/main/core/browser/test-support/user-agent-race.ts')],
      outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      plugins: [{
        name: 'isolate-browser-probe',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: imported }) => {
            if (stubs[imported]) return { path: imported, namespace: 'probe' };
            if (imported.startsWith('@shared/')) {
              return { path: path.join(repo, 'apps/desktop/src/session/shared', `${imported.slice(8)}.ts`) };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: 'probe' }, ({ path: imported }) => ({ contents: stubs[imported] }));
        },
      }],
    });
  });

  afterAll(() => {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  });

  async function probe(bootstrap: boolean): Promise<Probe> {
    const profile = path.join(temporary, bootstrap ? 'fixed' : 'control');
    const env: NodeJS.ProcessEnv = {
      ...process.env, GUGU_HOME: path.join(profile, 'home'), GUGU_USER_DATA_DIR: path.join(profile, 'user-data'),
      GUGU_SERVER_MODE: '0', UA_PROBE_REPO: repo, UA_PROBE_BOOTSTRAP: bootstrap ? '1' : '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron!, [temporary], { env, signal: AbortSignal.timeout(35_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`${String(error)}\n${stdout}\n${stderr}`, { cause: error })));
      child.once('close', resolve);
    });
    expect(code, stderr).toBe(0);
    const line = stdout.split('\n').find((value) => value.startsWith('UA_PROBE_RESULT='));
    expect(line, `${stdout}\n${stderr}`).toBeDefined();
    return JSON.parse(line!.slice('UA_PROBE_RESULT='.length)) as Probe;
  }

  it('proves a clean Session and WebContents can still send the branded fallback', async () => {
    const control = await probe(false);
    expect(control.profileAgent).toBe(control.clean);
    expect(control.contentsAgent).toBe(control.clean);
    expect(control.fallback).toContain('咕咕Beta/');
    expect(control.initialDocumentAgent).toContain('咕咕Beta/');
    expect(control.documentAgents).toHaveLength(2);
    expect(control.documentAgents.every((agent) => agent.includes('咕咕Beta/'))).toBe(true);
    expect(control.requests.map((request) => request.url)).toEqual(['/landing', '/form']);
    // Node decodes HTTP header bytes as Latin-1; compare the original UTF-8 bytes.
    expect(control.requests.every((request) => request.userAgent.includes(Buffer.from('咕咕Beta').toString('latin1')))).toBe(true);
  }, 45_000);

  it('keeps the initial document, navigated page and iframe clean with the bootstrap', async () => {
    const fixed = await probe(true);
    expect(fixed.fallback).toBe(fixed.clean);
    expect(fixed.initialDocumentAgent).toBe(fixed.clean);
    expect(fixed.documentAgents).toEqual([fixed.clean, fixed.clean]);
    expect(fixed.requests).toEqual([
      { url: '/landing', userAgent: fixed.clean },
      { url: '/form', userAgent: fixed.clean },
    ]);
  }, 45_000);
});
