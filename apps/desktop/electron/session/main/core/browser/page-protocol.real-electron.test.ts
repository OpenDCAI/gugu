import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Same native runner as browser-user-agent.real-electron.test.ts. No account or model is used.
const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
const repo = process.cwd();
let temporary = '';
let result: { cases: Record<string, { passed: boolean; error?: string }> };

describe.skipIf(!electron)('page protocol with real Electron and Playwright MCP', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-page-protocol-'));
    const logger = 'export const log={info(){},warn(){},error(){},debug(){}};export const createLogger=()=>log';
    const stubs: Record<string, string> = {
      '@main/lib/events': 'export const events={emit(...args){globalThis.pageProbeEvent?.(...args)}}',
      '@main/lib/logger': logger,
      '@main/core/extensions/extension-agent-context': 'export async function agentSessionContext(){return null}',
      '@main/core/sessions/session-orchestration': 'export async function openAgentBrowserPane(){}',
      './browser-webcontents-registry': 'export const browserWebContentsRegistry={setMouseDownObserver(){},browsersOfSession(){return []}}',
      './lib/logger': logger,
    };
    const entry = path.join(temporary, 'main.cjs');
    await build({
      entryPoints: [path.join(repo, 'apps/desktop/electron/session/main/core/browser/test-support/page-protocol-playwright.ts')],
      outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      define: { __filename: JSON.stringify(path.join(repo, 'package.json')) },
      plugins: [{ name: 'native-page-probe', setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: imported }) => {
          if (stubs[imported]) return { path: imported, namespace: 'probe' };
          if (imported.startsWith('@shared/')) return { path: path.join(repo, 'apps/desktop/src/session/shared', `${imported.slice(8)}.ts`) };
        });
        builder.onLoad({ filter: /.*/, namespace: 'probe' }, ({ path: imported }) => ({ contents: stubs[imported] }));
      } }],
    });
    const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: path.join(temporary, 'home'),
      GUGU_USER_DATA_DIR: path.join(temporary, 'user-data'), PAGE_PROBE_REPO: repo };
    fs.mkdirSync(env.GUGU_HOME!, { recursive: true });
    fs.mkdirSync(env.GUGU_USER_DATA_DIR!, { recursive: true });
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron!, [entry], { env, signal: AbortSignal.timeout(30_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (process.env.GUGU_BROWSER_PROBE_REPORT_DIR) {
      const folder = process.env.GUGU_BROWSER_PROBE_REPORT_DIR;
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'native-page.log'), stdout + '\n' + stderr);
    }
    expect(code, stdout + '\n' + stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('PAGE_PROTOCOL_RESULT='));
    expect(line, stdout + '\n' + stderr).toBeDefined();
    result = JSON.parse(line!.slice('PAGE_PROTOCOL_RESULT='.length));
  }, 40_000);
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  it.each(['same-iframe-click', 'cross-iframe-click', 'html-drag', 'surface failed', 'the page debugger is already in use',
    'http-only-cookie-events', 'navigation-schemes', 'drag-files', 'websocket-cookie-events',
    'navigation-control-file', 'navigation-control-chrome', 'navigation-control-devtools', 'navigation-history-policy',
    'history-file-script', 'history-file-alt-left', 'history-file-mouse-back',
    'history-chrome-script', 'history-chrome-alt-left', 'history-chrome-mouse-back',
    'history-file-current', 'history-file-owner-navigation'])('%s', name => {
    expect(result.cases[name], JSON.stringify(result.cases[name])).toEqual({ passed: true });
  });
});
