import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { assertNoUndefinedBindingsInEmdashBundles } from './verify-emdash-bundle-no-undef.mjs'
import { assertMainStaticGraphDefersHomeReaders } from './verify-main-static-graph.mjs'

const root = resolve(process.cwd())
const manifestRelative = 'dist/gugu-build-provenance.json'
const requiredPreloadSymbol = 'electronAPI'
const requiredSessionpageBridgeSymbol = 'setLocalSessionDeliveryBridge'
const repair = 'repair: pnpm build:app (automatic rebuild is intentionally disabled)'
const buildTag = process.env.GUGU_BUILD_TAG?.trim() || null
const testNotes = process.env.GUGU_TEST_NOTES?.trim() || null
// @@@task-fusion (#2802) — 会话页并入本体后构建输入的落点变了,这条白名单必须跟着改,
// 否则指纹会漏掉半个产品(改了会话页源码而指纹不变 = 溯源失效):
//   · 会话页的渲染层落到 apps/desktop/src/session/、主进程落到
//     apps/desktop/electron/session/ —— 两者已被现有的 `src/` 与 `electron/` 前缀覆盖,不必新增。
//   · 7 个 `packages/session-*` 是**按源码消费**的(exports 直接指向 src/,没有 build 产物),
//     必须显式纳入;它们的 package.json 也算输入 —— exports 表变了解析结果就变。
//   · `apps/desktop/session-embedded.html` 是本次 rollup 的**第二个入口**,与 index.html 同级。
//   · `scripts/build-emdash-assets.mjs` 已删,从脚本白名单里去掉。
const buildInputs = /^(?:apps\/desktop\/(?:electron|src)\/|apps\/desktop\/(?:index\.html|session-embedded\.html|package\.json)$|packages\/core\/src\/|packages\/session-[^/]+\/(?:src\/|package\.json$)|public\/|vite\.config\.mts$|package\.json$|pnpm-lock\.yaml$|tsconfig[^/]*\.json$|(?:postcss\.config\.mjs|tailwind\.config\.cjs)$|scripts\/(?:renderer-chunking|build-env-preflight|build-tmux-bundle|fetch-acp-adapters|extract-pr-test-notes|verify-emdash-bundle-no-undef|verify-main-static-graph)\.mjs$)/

function sourceFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
  return output.toString().split('\0').filter((file) => file && buildInputs.test(file)).sort()
}

export function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const file of sourceFiles()) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
  }
  return hash.digest('hex')
}

export function sourceState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
  return { commit, dirty: status.length > 0, fingerprint: sourceFingerprint() }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function rendererEntry(indexPath) {
  const index = readFileSync(indexPath, 'utf8')
  const script = new JSDOM(index).window.document.querySelector('script[type="module"][src]')?.getAttribute('src')
  if (!script) throw new Error(`[build-provenance] renderer entry script missing from ${relative(root, indexPath)}`)
  const normalizedScript = `/${script.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/, 1)[0]}`
  const path = join(root, 'dist', normalizedScript.slice(1))
  if (!existsSync(path)) throw new Error(`[build-provenance] renderer entry does not exist: ${relative(root, path)}`)
  return { script: normalizedScript, path }
}

function artifact(path) {
  if (!existsSync(path)) throw new Error(`[build-provenance] required artifact is missing: ${relative(root, path)}`)
  return { path: relative(root, path), sha256: sha256(path) }
}

function currentArtifacts() {
  assertNoUndefinedBindingsInEmdashBundles(join(root, 'apps/desktop/dist-electron'))
  assertMainStaticGraphDefersHomeReaders(join(root, 'apps/desktop/dist-electron'))
  const indexPath = join(root, 'dist/index.html')
  const preloadPath = join(root, 'apps/desktop/dist-electron/preload.js')
  const main = artifact(join(root, 'apps/desktop/dist-electron/main.js'))
  const sessionpageBridge = artifact(join(root, 'apps/desktop/dist-electron/emdash-main-bridge.js'))
  const preloadArtifact = artifact(preloadPath)
  const index = artifact(indexPath)
  const renderer = rendererEntry(indexPath)
  const preload = readFileSync(preloadPath, 'utf8')
  const sessionpageBridgeSource = readFileSync(sessionpageBridge.path, 'utf8')
  return {
    main,
    sessionpageBridge,
    preload: preloadArtifact,
    index,
    renderer: artifact(renderer.path),
    rendererScript: renderer.script,
    preloadSymbolPresent: preload.includes(requiredPreloadSymbol),
    sessionpageBridgeSymbolPresent: sessionpageBridgeSource.includes(requiredSessionpageBridgeSymbol),
  }
}

export function writeProvenance() {
  const source = sourceState()
  const artifacts = currentArtifacts()
  if (!artifacts.preloadSymbolPresent) {
    throw new Error(`[build-provenance] preload is missing required bridge symbol ${JSON.stringify(requiredPreloadSymbol)}`)
  }
  if (!artifacts.sessionpageBridgeSymbolPresent) {
    throw new Error(
      `[build-provenance] sessionpage bridge is missing required bridge symbol ${JSON.stringify(requiredSessionpageBridgeSymbol)}`,
    )
  }
  const manifest = {
    schema: 1,
    buildTag,
    testNotes,
    source,
    artifacts: {
      main: artifacts.main,
      sessionpageBridge: artifacts.sessionpageBridge,
      preload: artifacts.preload,
      index: artifacts.index,
      renderer: artifacts.renderer,
    },
    rendererScript: artifacts.rendererScript,
    requiredPreloadSymbol,
    requiredSessionpageBridgeSymbol,
  }
  const output = join(root, manifestRelative)
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`[build-provenance] wrote ${manifestRelative}; source=${sourceLabel(source)}\n`)
}

function sourceLabel(source) {
  return `${source.commit}${source.dirty ? '+dirty' : ''} (sha256:${source.fingerprint})`
}

export function validateProvenanceManifest(manifest) {
  if (manifest?.schema !== 1 || !manifest.source?.commit || !manifest.source?.fingerprint) {
    throw new Error(`unsupported or incomplete identity (schema ${JSON.stringify(manifest?.schema)})`)
  }
  if (manifest.buildTag !== undefined && manifest.buildTag !== null && typeof manifest.buildTag !== 'string') {
    throw new Error('buildTag must be a string or null')
  }
  for (const name of ['main', 'preload', 'index', 'renderer', 'sessionpageBridge']) {
    const artifact = manifest.artifacts?.[name]
    if (!artifact?.path || !artifact?.sha256) throw new Error(`artifacts.${name} is missing or incomplete`)
  }
  if (!manifest.rendererScript) throw new Error('rendererScript is missing')
  if (!manifest.requiredPreloadSymbol) throw new Error('requiredPreloadSymbol is missing')
  if (!manifest.requiredSessionpageBridgeSymbol) throw new Error('requiredSessionpageBridgeSymbol is missing')
  return manifest
}

export function checkProvenance() {
  const manifestPath = join(root, manifestRelative)
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[e2e provenance] build manifest is missing: ${manifestRelative}; these artifacts have no source identity and are too old to measure safely.\n  ${repair}`,
    )
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`[e2e provenance] build manifest is unreadable: ${error instanceof Error ? error.message : String(error)}\n  ${repair}`)
  }
  try { validateProvenanceManifest(manifest) } catch (error) {
    throw new Error(`[e2e provenance] build manifest is invalid: ${error.message}\n  ${repair}`)
  }
  const currentSource = sourceState()
  let current
  try {
    current = currentArtifacts()
  } catch (error) {
    throw new Error(
      `[e2e provenance] refusing to launch Electron because the artifact set is incomplete or invalid: ${error instanceof Error ? error.message : String(error)}` +
      `\n  artifact source: ${sourceLabel(manifest.source)}` +
      `\n  current source: ${sourceLabel(currentSource)}` +
      `\n  ${repair}`,
    )
  }
  const failures = []
  if (manifest.source.fingerprint !== currentSource.fingerprint) failures.push('source fingerprint differs')
  for (const name of ['main', 'preload', 'index', 'renderer', 'sessionpageBridge']) {
    const expected = manifest.artifacts?.[name]
    const actual = current[name]
    if (!expected || expected.path !== actual.path || expected.sha256 !== actual.sha256) {
      failures.push(`${name} artifact differs: expected ${expected?.path ?? 'missing'} ${expected?.sha256 ?? 'missing'}, current ${actual.path} ${actual.sha256}`)
    }
  }
  if (manifest.rendererScript !== current.rendererScript) {
    failures.push(`index loads ${current.rendererScript}, manifest names ${manifest.rendererScript ?? 'missing'}`)
  }
  if (manifest.requiredPreloadSymbol !== requiredPreloadSymbol || !current.preloadSymbolPresent) {
    failures.push(`preload bridge symbol ${JSON.stringify(requiredPreloadSymbol)} is missing`)
  }
  if (!current.sessionpageBridgeSymbolPresent) {
    failures.push(`sessionpage bridge symbol ${JSON.stringify(requiredSessionpageBridgeSymbol)} is missing`)
  }
  if (manifest.requiredSessionpageBridgeSymbol !== requiredSessionpageBridgeSymbol) {
    failures.push(`sessionpage bridge symbol contract changed: manifest names ${manifest.requiredSessionpageBridgeSymbol ?? 'missing'}`)
  }
  if (failures.length > 0) {
    throw new Error(
      '[e2e provenance] refusing to launch Electron with artifacts that do not match the current source.\n' +
      failures.map((failure) => `  - ${failure}`).join('\n') +
      `\n  artifact source: ${sourceLabel(manifest.source)}` +
      `\n  current source: ${sourceLabel(currentSource)}` +
      `\n  ${repair}`,
    )
  }
  process.stdout.write(
    `[e2e provenance] launch allowed; source=${sourceLabel(currentSource)}; ` +
    `main=${current.main.sha256}; preload=${current.preload.sha256}; index=${current.index.sha256}; ` +
    `renderer=${current.rendererScript} ${current.renderer.sha256}; ` +
    `sessionpage-bridge=${current.sessionpageBridge.sha256}; ` +
    `preload-symbol=${requiredPreloadSymbol}; sessionpage-bridge-symbol=${requiredSessionpageBridgeSymbol}\n`,
  )
}

try {
  if (process.argv.includes('--write')) writeProvenance()
  if (process.argv.includes('--check')) checkProvenance()
  if (process.argv.includes('--source-json')) process.stdout.write(`${JSON.stringify(sourceState())}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
