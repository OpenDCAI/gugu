#!/usr/bin/env node
// Reproduce the maintained macOS source build; normal app packaging downloads its pinned archive.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metadataDir = path.join(root, 'apps/desktop/native/cua-driver')
const metadata = JSON.parse(fs.readFileSync(path.join(metadataDir, 'patched-macos.json'), 'utf8'))
const arg = name => process.argv[process.argv.indexOf(name) + 1]
if (!process.argv.includes('--source') || !process.argv.includes('--out')) throw new Error('Usage: build-cua-driver-patched-macos.mjs --source <clean cua checkout> --out <binary> [--arch arm64|x64] [--toolchain nightly]')
if (process.platform !== 'darwin') throw new Error('The patched macOS driver must be built on macOS')
const source = path.resolve(arg('--source'))
const out = path.resolve(arg('--out'))
const arch = process.argv.includes('--arch') ? arg('--arch') : process.arch
const target = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[arch]
if (!target) throw new Error(`Unsupported macOS architecture: ${arch}`)
const toolchain = process.argv.includes('--toolchain') ? arg('--toolchain') : 'nightly'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => execFileSync('git', args, { cwd: source })
if (git(['rev-parse', 'HEAD']).toString().trim() !== metadata.upstreamCommit) throw new Error(`Cua checkout must be exactly ${metadata.upstreamCommit}`)
const patch = fs.readFileSync(path.join(metadataDir, metadata.patch))
if (sha(patch) !== metadata.patchSha256) throw new Error('Maintained source patch checksum mismatch')
const diff = () => git(['diff', '--binary', '--full-index', 'HEAD'])
if (diff().length === 0) git(['apply', '--check', path.join(metadataDir, metadata.patch)])
if (diff().length === 0) git(['apply', path.join(metadataDir, metadata.patch)])
if (sha(diff()) !== metadata.patchSha256) throw new Error('Cua checkout contains changes other than the maintained patch')
for (const [file, expected] of Object.entries(metadata.sourceHashes)) {
  if (sha(fs.readFileSync(path.join(source, file))) !== expected) throw new Error(`Source checksum mismatch: ${file}`)
}
const rustc = execFileSync('rustc', [`+${toolchain}`, '-Vv'], { encoding: 'utf8' })
if (!rustc.includes(`release: ${metadata.rustcRelease}\n`) || !rustc.includes(`commit-hash: ${metadata.rustcCommitPrefix}`)) throw new Error(`Use the recorded Rust compiler (${metadata.rustcRelease}, ${metadata.rustcCommitPrefix}); got ${rustc.split('\n')[0]}`)
const workspace = path.join(source, 'libs/cua-driver/rust')
execFileSync('cargo', [`+${toolchain}`, 'build', '--locked', '--release', '-p', 'cua-driver', '--target', target, '--target-dir', path.join(workspace, 'target')], {
  cwd: workspace, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' },
})
const built = path.join(workspace, 'target', target, 'release/cua-driver')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.copyFileSync(built, out)
fs.chmodSync(out, 0o755)
console.log(`${metadata.revision} ${target}: ${sha(fs.readFileSync(out))} ${out}`)
