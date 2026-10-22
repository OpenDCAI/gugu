// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

/** The headless modules use TS contracts plus a Capacitor transport alias, exactly as the APK
 * bundle does. Run their Node unit tests after that same compilation, without a live service. */
it('preserves phone runtime identity, delivery, permissions, confirmation and recovery contracts', async () => {
  const root = process.cwd()
  const source = resolve(root, 'apps/mobile/runtime')
  const tests = (await readdir(source)).filter((name) => name.endsWith('.test.mjs'))
  expect(tests).toContain('phone-actions.test.mjs')
  expect(tests).toContain('phone-agent-host.test.mjs')
  const out = await mkdtemp(join(tmpdir(), 'gugu-phone-runtime-unit-'))
  try {
    await build({ entryPoints: tests.map((name) => join(source, name)), outdir: out, bundle: true, platform: 'node', target: 'node24', format: 'esm', outExtension: { '.js': '.mjs' },
      alias: { '@capacitor/core': join(source, 'phone-capacitor.mjs') },
      banner: { js: "import { createRequire as __guguCreateRequire } from 'node:module'; const require = __guguCreateRequire(import.meta.url);" }, logLevel: 'silent' })
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', ...tests.map((name) => join(out, name))], { cwd: root, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }).catch((cause: unknown) => {
      const failure = cause as { stdout?: string; stderr?: string }
      throw new Error(`Phone runtime contract tests failed:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause })
    })
    expect(stdout).toMatch(/(?:# fail 0|ℹ fail 0)/)
    expect(stdout).toMatch(/(?:# tests [1-9]\d*|ℹ tests [1-9]\d*)/)
  } finally { await rm(out, { recursive: true, force: true }) }
}, 120_000)
