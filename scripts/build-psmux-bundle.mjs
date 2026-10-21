// @@@bundle-psmux - Windows does not have a native tmux. psmux ships a tmux-compatible command face
// backed by Windows ConPTY, so vendor its `tmux.exe` into the Windows app and let the existing
// TmuxTerminal path stay the single controlled-agent primitive.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'psmux-bundle')
const version = 'v3.3.5'
const zipName = `psmux-${version}-windows-x64.zip`
const downloadUrl = `https://github.com/psmux/psmux/releases/download/${version}/${zipName}`
const expectedSha256 = '7e3059f082df01eaa233bc50dbf62650d993150029b1d12327d3fcae2f6db808'
const bundleNames = ['tmux.exe', 'psmux.exe', 'pmux.exe', 'LICENSE', 'README.md']
const executableNames = ['tmux.exe', 'psmux.exe', 'pmux.exe']

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: options.stdio ?? 'pipe' })
}

function download(url, output) {
  try {
    sh('curl', ['-L', '--fail', '--silent', '--show-error', '-o', output, url], {
      stdio: 'inherit'
    })
  } catch (error) {
    throw new Error(
      `failed to download psmux from ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function extractZip(zipPath, outputDir) {
  if (process.platform === 'win32') {
    sh('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${powerShellString(zipPath)} -DestinationPath ${powerShellString(outputDir)} -Force`
    ])
    return
  }
  sh('unzip', ['-q', zipPath, '-d', outputDir])
}

function powerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function copyCompleteBundle(sourceDir, sourceLabel) {
  for (const name of bundleNames) {
    const source = join(sourceDir, name)
    if (!existsSync(source)) throw new Error(`${sourceLabel} missing ${name}`)
    copyFileSync(source, join(outDir, basename(name)))
  }
  for (const name of executableNames) chmodSync(join(outDir, name), 0o755)
}

const override = process.env.GUGU_BUNDLE_PSMUX?.trim()
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

if (override) {
  if (!existsSync(override)) throw new Error(`GUGU_BUNDLE_PSMUX does not exist: ${override}`)
  if (statSync(override).isDirectory()) {
    copyCompleteBundle(override, 'psmux override')
    console.log('bundled complete psmux bundle from override:', override)
  } else {
    copyFileSync(override, join(outDir, 'tmux.exe'))
    chmodSync(join(outDir, 'tmux.exe'), 0o755)
    console.log('bundled psmux tmux.exe from override:', override)
  }
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'gugu-psmux-'))
try {
  const zipPath = join(workDir, zipName)
  const extractDir = join(workDir, 'extract')
  mkdirSync(extractDir, { recursive: true })
  download(downloadUrl, zipPath)
  const actualSha256 = sha256(zipPath)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`psmux zip sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  extractZip(zipPath, extractDir)
  copyCompleteBundle(extractDir, 'psmux archive')
  // A macOS build host cannot execute the Windows PE binary. The archive layout + sha256 pin is the
  // build-time proof; Chole YATU is the runtime proof.
  console.log('bundled psmux ->', outDir, '|', version)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
