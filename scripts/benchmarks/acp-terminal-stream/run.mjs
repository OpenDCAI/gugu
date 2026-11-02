import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run sequentially. The fixture uses the actual bootAcpRuntimeProcess, stdio ingress,
// live models and fork IPC, without a GUI, model service or personal account.
const fixture = dirname(fileURLToPath(import.meta.url))
const root = resolve(fixture, '../../..')
const base = process.argv[2]
if (!base)
  throw new Error(
    'Usage: node scripts/benchmarks/acp-terminal-stream/run.mjs <base-ref> [result.json]'
  )
const dir = mkdtempSync(join(tmpdir(), 'gugu-acp-memory-'))
try {
  const before = execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim()
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const changed = execFileSync('git', ['diff', '--name-only', before], {
    cwd: root,
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  const originals = new Map()
  for (const path of changed) {
    try {
      originals.set(
        resolve(root, path),
        execFileSync('git', ['show', before + ':' + path], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      )
    } catch {
      /* New files are not imported by the baseline's original sources. */
    }
  }
  const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'warning',
    banner: {
      js: "import{createRequire as __benchCreateRequire}from'node:module';const require=__benchCreateRequire(import.meta.url);"
    },
    external: ['electron', 'node-pty', 'better-sqlite3', '@parcel/watcher']
  }
  await build({
    ...common,
    entryPoints: [join(fixture, 'parent.mjs')],
    outfile: join(dir, 'parent.mjs')
  })
  writeFileSync(join(dir, 'provider.mjs'), readFileSync(join(fixture, 'provider.mjs')))
  const results = []
  for (const mode of ['before', 'after']) {
    await build({
      ...common,
      entryPoints: [join(fixture, 'worker.mjs')],
      outfile: join(dir, 'acp-runtime.' + mode + '.mjs'),
      plugins:
        mode === 'before'
          ? [
              {
                name: 'baseline-source',
                setup(builder) {
                  builder.onLoad({ filter: /\.(ts|mjs)$/ }, (args) =>
                    originals.has(args.path)
                      ? {
                          contents: originals.get(args.path),
                          loader: args.path.endsWith('.ts') ? 'ts' : 'js',
                          resolveDir: dirname(args.path)
                        }
                      : undefined
                  )
                }
              }
            ]
          : []
    })
    const run = spawnSync(process.execPath, [join(dir, 'parent.mjs'), dir, mode], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BENCH_SOURCE: mode === 'before' ? before : after },
      timeout: 90000
    })
    if (run.status !== 0) throw new Error(run.stderr || run.stdout || String(run.error))
    results.push(JSON.parse(readFileSync(join(dir, mode + '.json'), 'utf8')))
  }
  const report = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    workload:
      '400 x 64 KiB ASCII chunks, 8ms producer interval, 120ms per client update; maxRSS is KiB',
    results
  }
  if (process.argv[3])
    writeFileSync(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
