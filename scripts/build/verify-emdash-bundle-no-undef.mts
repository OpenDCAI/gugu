import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'

// eslint 8 ships no type declarations; this is the slice of its Linter API the verifier uses.
interface LintMessage {
  severity: number
  line?: number
  column?: number
  message: string
}
interface EslintLinter {
  verify(code: string, config: object, options: { filename: string; allowInlineConfig: boolean }): LintMessage[]
}
const { Linter } = createRequire(import.meta.url)('eslint') as { Linter: new () => EslintLinter }

const EMDASH_BUNDLE_GLOBALS = Object.fromEntries(
  [
    'define',
    'Deno',
    'Float16Array',
    'GENTLY',
    'EdgeRuntime',
    'Iterator',
    'AsyncIterator',
    'SuppressedError',
    'WorkerGlobalScope',
  ].map((name) => [name, 'readonly']),
)

const BUNDLE_FILE_RE = /(?:^|[\\/])emdash-main-bridge(?:-[^/\\]+)?\.(?:cjs|js)$|(?:^|[\\/])(?:acp-runtime|agent-config-runtime|fs-watch-runtime)\.js$/

function bundleFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...bundleFiles(path))
    else if (BUNDLE_FILE_RE.test(path)) files.push(path)
  }
  return files.sort()
}

/**
 * Verify every emitted session bridge/worker bundle rejects no-undef references.
 * The verifier is independent of the bundler so esbuild and Rollup share the same gate.
 */
export function assertNoUndefinedBindingsInEmdashBundles(distElectronDir: string): { files: string[] } {
  const files = bundleFiles(distElectronDir)
  if (files.length === 0) {
    throw new Error(`session bundle verifier found no bridge/worker artifacts under ${distElectronDir}`)
  }

  const linter = new Linter()
  const config = {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'script' },
    env: { node: true, browser: true, es2022: true },
    globals: EMDASH_BUNDLE_GLOBALS,
    rules: { 'no-undef': 'error' },
  }
  const failures: Array<{ file: string; errors: Array<{ line?: number; column?: number; message: string }>; count: number }> = []
  for (const file of files) {
    const messages = linter.verify(readFileSync(file, 'utf8'), config, {
      filename: file,
      allowInlineConfig: false,
    })
    const errors = messages.filter((message) => message.severity === 2)
    if (errors.length > 0) {
      failures.push({
        file,
        errors: errors.slice(0, 12).map((message) => ({
          line: message.line,
          column: message.column,
          message: message.message,
        })),
        count: errors.length,
      })
    }
  }
  if (failures.length > 0) {
    const details = failures
      .map(({ file, errors, count }) => {
        const shown = errors.map((error) => `${error.line ?? '?'}:${error.column ?? '?'} ${error.message}`).join('; ')
        return `${basename(file)} (${count}): ${shown}`
      })
      .join('\n  ')
    throw new Error(`session bundles contain strict-mode undefined bindings:\n  ${details}`)
  }
  return { files }
}

if (process.argv[1] && process.argv[1].endsWith('verify-emdash-bundle-no-undef.mts')) {
  const distElectronDir = process.argv[2]
  if (!distElectronDir) throw new Error('usage: node scripts/build/verify-emdash-bundle-no-undef.mts <dist-electron>')
  const started = Date.now()
  const result = assertNoUndefinedBindingsInEmdashBundles(distElectronDir)
  process.stdout.write(
    `[session no-undef] checked ${result.files.length} bundle(s) in ${Date.now() - started}ms\n`,
  )
}
