import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('copies physical ASAR files without changing Electron fs, then retries failed home initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-home-asar-'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const core = resolve('packages/session-core/src/agents/plugins/helpers/index.ts');
    const output = join(root, 'host.cjs');
    await build({
      entryPoints: [join(here, 'agent-home.ts')], outfile: output,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(output).href) },
      plugins: [{ name: 'synthetic-provider-wiring', setup(builder) {
        builder.onResolve({ filter: /^@gugu\/session-core\/agents\/plugins\/helpers$/ }, () => ({ path: core }));
        builder.onResolve({ filter: /^@main\/core\/agents\/plugin-registry$/ }, () => ({ path: 'provider', namespace: 'synthetic' }));
        builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: `
          export const getPlugin = () => ({capabilities:{sessionBundle:{
            injectionMode:'managed-config-root',configRoot:{
              envVar:'GEMINI_HOME',userPath:'.gemini',carryExclusions:[],seedFiles:[]
            }
          }}});` }));
      } }],
    });
    const fixture = join(root, 'probe.cjs');
    await writeFile(fixture, `
      const assert=require('node:assert/strict'),path=require('node:path');
      const fs=require('node:fs'),physical=require('original-fs');
      const home=path.join(__dirname,'user'),source=path.join(home,'.gemini');
      const scratch=path.join(source,'antigravity/brain/project/scratch');
      physical.mkdirSync(scratch,{recursive:true});
      const json=Buffer.from(JSON.stringify({files:{missing:{size:7,unpacked:true}}}));
      const n=Math.ceil((json.length+4)/4)*4,h=Buffer.alloc(4+n),s=Buffer.alloc(8);
      h.writeUInt32LE(n,0);h.writeUInt32LE(json.length,4);json.copy(h,8);
      s.writeUInt32LE(4,0);s.writeUInt32LE(h.length,4);
      const archive=path.join(scratch,'app.asar');physical.writeFileSync(archive,Buffer.concat([s,h]));
      const original=physical.readFileSync(archive),noAsar=process.noAsar;
      assert(fs.statSync(archive).isDirectory());assert(physical.statSync(archive).isFile());
      physical.symlinkSync(archive,path.join(source,'archive-link'));
      physical.symlinkSync(path.join(source,'absent'),path.join(source,'broken-link'));
      physical.writeFileSync(path.join(source,'settings.json'),'source');
      const bomb=path.join(source,'oversized-config');
      const fd=physical.openSync(bomb,'w');physical.ftruncateSync(fd,2*1024*1024*1024+1);physical.closeSync(fd);
      process.env.HOME=home;process.env.GEMINI_HOME=source;process.env.GUGU_HOME=path.join(__dirname,'managed');
      const target=path.join(process.env.GUGU_HOME,'agent-homes/antigravity/.gemini');
      physical.mkdirSync(target,{recursive:true});physical.writeFileSync(path.join(target,'settings.json'),'owned');
      const host=require('./host.cjs');
      (async()=>{
        const failed=await Promise.allSettled([host.resolveAgentHomeEnv('antigravity'),host.resolveAgentHomeRoot('antigravity')]);
        assert(failed.every(r=>r.status==='rejected'&&r.reason.message.includes('MiB')));
        physical.writeFileSync(bomb,'repaired');
        const [env,shadow]=await Promise.all([host.resolveAgentHomeEnv('antigravity'),host.resolveAgentHomeRoot('antigravity')]);
        assert.equal(env.GEMINI_HOME,target);assert.equal(shadow,path.dirname(target));
        assert.equal(physical.readFileSync(path.join(target,'settings.json'),'utf8'),'owned');
        for(const p of [path.join(target,'archive-link'),path.join(target,'antigravity/brain/project/scratch/app.asar')]){
          assert(physical.lstatSync(p).isFile());assert.deepEqual(physical.readFileSync(p),original);
        }
        assert(!physical.existsSync(path.join(target,'broken-link')));
        assert(fs.statSync(archive).isDirectory());assert.equal(process.noAsar,noAsar);
        console.log(JSON.stringify({electron:process.versions.electron,copied:true,retried:true,globalAsarUnchanged:true}));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `);
    const electron = createRequire(import.meta.url)('electron') as string;
    const { stdout } = await promisify(execFile)(electron, [fixture], {
      env: { ...process.env, NODE_PATH: resolve('node_modules'), ELECTRON_RUN_AS_NODE: '1', HOME: join(root, 'host-home'),
        GUGU_HOME: join(root, 'home'), GUGU_USER_DATA_DIR: join(root, 'profile') },
      timeout: 30_000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ copied: true, retried: true, globalAsarUnchanged: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
