import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
let temporary = '';
let cases: Record<string, { passed: boolean; error?: string }>;

// Hidden fixtures exercise capturePage/insertText and the production viewer; no account or model is used.
describe.skipIf(!electron)('shared local projection with real Electron', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-projection-'));
    const repo = process.cwd();
    const support = path.join(repo, 'apps/desktop/electron/session/main/core/extensions/test-support');
    const shared = { name: 'projection-shared', setup(builder: import('esbuild').PluginBuild) {
      builder.onResolve({ filter: /^@shared\// }, ({ path: imported }) => ({ path: path.join(repo, 'apps/desktop/src/session/shared', `${imported.slice(8)}.ts`) }));
    } };
    await build({ entryPoints: [path.join(support, 'projection-renderer.ts')], outfile: path.join(temporary, 'viewer.js'),
      bundle: true, platform: 'browser', format: 'iife', plugins: [shared] });
    const stubs: Record<string, string> = {
      './extensions-root': 'export function extensionsService(){return {get(){},isEnabled(){return true},hasCapability(){return true}}}',
      './app-programs-elsewhere': 'export function knownSessionMachine(){return undefined}',
    };
    await build({ entryPoints: [path.join(support, 'projection-electron.ts')], outfile: path.join(temporary, 'main.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [shared, {
        name: 'fixture-grants', setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: imported }) => stubs[imported] ? { path: imported, namespace: 'fixture' } : undefined);
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: imported }) => ({ contents: stubs[imported] }));
        },
      }] });
    fs.writeFileSync(path.join(temporary, 'viewer.html'), '<body style="margin:0"><div id="projection" style="width:100vw;height:100vh"></div><script src="viewer.js"></script>');
    fs.writeFileSync(path.join(temporary, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('fixture',{call:(method,args)=>ipcRenderer.invoke('projection',method,args),
hear:callback=>{const handler=(_event,watch,packet)=>callback(watch,packet);ipcRenderer.on('projection',handler);return ()=>ipcRenderer.removeListener('projection',handler)}});`);
    const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: path.join(temporary, 'user-data') };
    fs.mkdirSync(env.GUGU_HOME!, { recursive: true }); fs.mkdirSync(env.GUGU_USER_DATA_DIR!, { recursive: true });
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron!, [path.join(temporary, 'main.cjs')], { env, signal: AbortSignal.timeout(25_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (process.env.GUGU_BROWSER_PROBE_REPORT_DIR) {
      fs.mkdirSync(process.env.GUGU_BROWSER_PROBE_REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GUGU_BROWSER_PROBE_REPORT_DIR, 'native-projection.log'), stdout + '\n' + stderr);
    }
    expect(code, stdout + '\n' + stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('PROJECTION_RESULT='));
    expect(line, stdout + '\n' + stderr).toBeDefined();
    cases = JSON.parse(line!.slice('PROJECTION_RESULT='.length)).cases;
  }, 35_000);
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  it.each(['native-capture-and-render', 'native-unicode-once-and-target-isolation', 'native-app-revocation'])('%s', name => {
    expect(cases[name], JSON.stringify(cases[name])).toEqual({ passed: true });
  });
});
