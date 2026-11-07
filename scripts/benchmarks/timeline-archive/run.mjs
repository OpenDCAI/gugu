import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic only. Bundle the actual timeline, readers and archive store from
// each revision; substitute only Electron's userData path and the logger.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const base = process.argv[2] ?? 'dff8b960';
const output = process.argv[3];
const temporary = mkdtempSync(join(tmpdir(), 'gugu-timeline-bench-'));
const checkDisk = () => {
  const fs = statfsSync(root);
  if (fs.bavail * fs.bsize < 16 * 1024 ** 3) throw new Error('Free disk below 16 GiB; stopping');
};
try {
  checkDisk();
  const original = new Map();
  const before = execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim();
  const paths = execFileSync('git', ['diff', '--name-only', before], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  for (const path of paths) {
    try {
      original.set(resolve(root, path), execFileSync('git', ['show', `${before}:${path}`], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch { /* Added files are unreachable from the baseline. */ }
  }
  for (const mode of ['old', 'new']) {
    await build({
      entryPoints: [join(here, 'probe.ts')], outfile: join(temporary, `${mode}.mjs`),
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
      tsconfig: join(root, 'tsconfig.json'),
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
      plugins: [{ name: 'archive-benchmark', setup(builder) {
        builder.onResolve({ filter: /^(electron|@main\/lib\/logger|@gugu\/session-core\/session-record)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
          args.path === 'electron' ? 'export const app = {getPath: () => process.env.GUGU_USER_DATA_DIR};'
            : args.path === '@main/lib/logger' ? 'export const log = {info(){}, warn(){}};'
              : `export * from ${JSON.stringify(join(root, 'packages/session-core/src/session-record/timeline.ts'))};\n`
                + (mode === 'new' ? `export * from ${JSON.stringify(join(root, 'packages/session-core/src/session-record/archive-budget.ts'))};` : ''),
          resolveDir: root, loader: 'ts',
        }));
        if (mode === 'old') builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
          const contents = original.get(args.path);
          return contents === undefined ? undefined : { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
        });
      } }],
    });
  }
  const rounds = Number(process.env.GUGU_BENCH_ROUNDS ?? 40);
  checkDisk();
  writeFileSync(join(temporary, 'compare.mjs'), readFileSync(join(here, 'compare.mjs')));
  const runDir = join(temporary, 'synthetic');
  const child = spawnSync(process.execPath, ['--expose-gc', join(temporary, 'compare.mjs'), runDir, String(rounds)], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'production', GUGU_HOME: join(runDir, 'home'), GUGU_USER_DATA_DIR: join(runDir, 'user-data') },
  });
  if (child.status !== 0) throw new Error(`${child.stderr}\n${child.stdout}`);
  const runs = JSON.parse(child.stdout);
  const report = { base: before, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    candidateIncludesWorkingTree: spawnSync('git', ['diff', '--quiet'], { cwd: root }).status !== 0, node: process.version, cpu: cpus()[0].model, pairedRounds: rounds, runs };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, json);
  console.log(json);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
