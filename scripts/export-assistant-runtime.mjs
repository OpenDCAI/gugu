import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Export the installed managed runtime for this release's cloud seed. This
 * neither selects nor updates any CLI, and never accepts a user-selected copy. */
const { values } = parseArgs({ options: {
  launcher: { type: 'string' }, output: { type: 'string' }, 'client-sha': { type: 'string' },
} })
if (!values.launcher || !values.output || !/^[a-f0-9]{40}$/.test(values['client-sha'] ?? '')) {
  throw new Error('Usage: --launcher <managed agents/mise-bin/claude> --output <manifest.json> --client-sha <40-hex release source>')
}
const launcher = resolve(values.launcher)
if (basename(dirname(launcher)) !== 'mise-bin' || basename(dirname(dirname(launcher))) !== 'agents' || !/^claude(?:\.cmd)?$/.test(basename(launcher))) {
  throw new Error('Only the Gugu-managed Claude launcher can supply the assistant runtime')
}
const script = await readFile(launcher, 'utf8')
const version = /^(?:#|rem) gugu-release: (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\s*$/im.exec(script)?.[1]
if (!version) throw new Error('Managed launcher has no release identity')
const { stdout } = await promisify(execFile)(launcher, ['--version'], { timeout: 15_000, windowsHide: true })
if (stdout.trim().split(/\s/)[0] !== version) throw new Error('Managed launcher release differs from the executable version')
const manifest = { format: 1, claude: version, client_sha: values['client-sha'], observed_at: new Date().toISOString(), source: 'gugu-managed-runtime' }
await writeFile(values.output, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
console.log(`Assistant managed runtime: Claude ${version}`)
