import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const MATRIX_CHAINS = [
  { id: 'claude-tui', model: 'glm-5.2', multiplier: 0.55 },
  { id: 'claude-cui', model: 'gpt-5.6', multiplier: 2.5 },
  { id: 'codex-tui', model: 'glm-5-turbo', multiplier: 0.47 },
  { id: 'codex-cui', model: 'gpt-5.5', multiplier: 2.5 },
  { id: 'opencode-tui', model: 'gpt-5.6-luna', multiplier: 0.1 },
  { id: 'opencode-cui', model: 'glm-5.2', multiplier: 0.55 },
]

export const HUMAN_STEPS = [
  'create-3-sessions',
  'switch-model',
  'toggle-chat-ui',
  'reopen',
  'delete',
  'archive',
  'offline-once',
  'resize-window',
]

const CHAIN_CELLS = ['L1', 'L2', 'L3', 'L4', 'L5', 'H']
const MANIFEST_FORMAT = 'gugu.matrix-2503.run.v1'
const MUTATION_FORMAT = 'gugu.matrix-2503.mutation.v1'
const REQUIRED_GATES = ['typecheck', 'lint', 'unit', 'renderer']
const MAX_UPSTREAM_USD = 2
const MAX_SUBSCRIPTION_PERCENT = 30

export const EXPECTED_CELLS = [
  ...MATRIX_CHAINS.flatMap((chain) => CHAIN_CELLS.map((cell) => ({
    chain: chain.id,
    cell,
    model: chain.model,
    kind: 'chain',
  }))),
  { chain: 'context-window-claude', cell: 'CTX', model: 'gpt-5.6', kind: 'context' },
  { chain: 'context-window-codex', cell: 'CTX', model: 'gpt-5.5', kind: 'context' },
  ...MATRIX_CHAINS.map((chain) => ({
    chain: `byok-${chain.id}`,
    cell: 'BYOK',
    model: `byok:${chain.id.split('-')[0]}`,
    kind: 'byok',
  })),
  { chain: 'human-tui', cell: 'WALKTHROUGH', model: 'mixed', kind: 'human' },
  { chain: 'human-cui', cell: 'WALKTHROUGH', model: 'mixed', kind: 'human' },
]

function keyOf(record) {
  return `${record.chain}/${record.cell}`
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isInside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function requireFile(root, value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must name a file`)
  const path = resolve(root, value)
  if (!isInside(root, path)) throw new Error(`${label} escapes the evidence directory: ${value}`)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${value}`)
  const realPath = realpathSync(path)
  if (!isInside(root, realPath)) throw new Error(`${label} resolves outside the evidence directory: ${value}`)
  return path
}

function walkJsonFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

function discoverCellRecords(root) {
  const records = new Map()
  for (const path of walkJsonFiles(root)) {
    const value = readJson(path)
    if (!value || typeof value !== 'object' || typeof value.chain !== 'string' || typeof value.cell !== 'string') continue
    const key = keyOf(value)
    if (records.has(key)) throw new Error(`duplicate cell record ${key}`)
    records.set(key, { ...value, sourcePath: path })
  }
  return records
}

function siblingArtifacts(record) {
  const prefix = `${record.cell}-`
  return readdirSync(dirname(record.sourcePath), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => resolve(dirname(record.sourcePath), entry.name))
    .sort()
}

function requireArtifactSuffix(record, suffix, label) {
  const match = siblingArtifacts(record).find((path) => path.endsWith(suffix))
  if (!match) throw new Error(`${keyOf(record)} is missing ${label} (${suffix})`)
  return match
}

function validateCellArtifacts(root, expected, record) {
  const artifacts = [record.sourcePath]
  if (expected.kind === 'chain') {
    if (['L1', 'L2', 'L3', 'L4'].includes(expected.cell)) {
      artifacts.push(requireArtifactSuffix(record, '.png', 'screenshot'))
      artifacts.push(requireArtifactSuffix(record, '-gateway-log.json', 'gateway log'))
    } else if (expected.cell === 'H') {
      artifacts.push(requireArtifactSuffix(record, '-gateway-log.json', 'gateway log'))
    }
  } else if (expected.kind === 'context') {
    artifacts.push(requireArtifactSuffix(record, '.png', 'screenshot'))
    artifacts.push(requireArtifactSuffix(record, '-gateway-log.json', 'gateway log'))
    artifacts.push(requireArtifactSuffix(record, '-terminal.txt', 'terminal transcript'))
  } else if (expected.kind === 'byok') {
    artifacts.push(requireArtifactSuffix(record, '.png', 'screenshot'))
    artifacts.push(requireArtifactSuffix(record, '-process-tree.txt', 'sanitized process audit'))
  } else if (expected.kind === 'human') {
    const observations = record.observations ?? {}
    const steps = observations.steps
    if (!Array.isArray(steps) || HUMAN_STEPS.some((step) => !steps.includes(step))) {
      throw new Error(`${keyOf(record)} does not contain every required walkthrough step`)
    }
    if (!Array.isArray(observations.surprises) || observations.surprises.length !== 0) {
      throw new Error(`${keyOf(record)} has unresolved surprises`)
    }
    artifacts.push(requireFile(root, observations.recordingPath, `${keyOf(record)} recordingPath`))
  }
  for (const path of artifacts.filter((artifact) => artifact.endsWith('-gateway-log.json'))) {
    const gatewayLog = readJson(path)
    if (gatewayLog.commit !== record.commit) {
      throw new Error(`${keyOf(record)} gateway log commit ${gatewayLog.commit ?? 'missing'} does not match ${record.commit}`)
    }
  }
  return artifacts
}

function validateVerdict(expected, record) {
  if (record.verdict === 'pass') {
    if (record.waiver !== undefined) throw new Error(`${keyOf(record)} is PASS but still carries a waiver`)
    return
  }
  const waiverAllowed = expected.cell === 'L3' && expected.chain.startsWith('claude-')
  const issueReferences = String(record.waiver ?? '').match(/#\d+/g) ?? []
  if (
    !waiverAllowed ||
    record.verdict !== 'waived' ||
    issueReferences.length !== 1 ||
    issueReferences[0] !== '#2997'
  ) {
    throw new Error(`${keyOf(record)} has unauthorized verdict ${JSON.stringify(record.verdict)}`)
  }
}

function validateHRecord(chain, record) {
  const observations = record.observations ?? {}
  if (!Array.isArray(observations.offenders) || observations.offenders.length !== 0) {
    throw new Error(`${keyOf(record)} has H offenders`)
  }
  if (!Array.isArray(observations.allowedRejections) || observations.allowedRejections.length !== 0) {
    throw new Error(`${keyOf(record)} has an unapproved H rejection allowance`)
  }
  if (observations.advertisedMultiplier !== chain.multiplier || observations.displayedGatewayMultiplier !== chain.multiplier) {
    throw new Error(`${keyOf(record)} multiplier does not match ${chain.multiplier}`)
  }
}

function validateManifest(root, manifest, head) {
  if (manifest.format !== MANIFEST_FORMAT) throw new Error(`run manifest format must be ${MANIFEST_FORMAT}`)
  if (manifest.commit !== head) throw new Error(`run manifest commit ${manifest.commit ?? 'missing'} does not match ${head}`)
  const startedAt = typeof manifest.startedAt === 'string' ? Date.parse(manifest.startedAt) : Number.NaN
  const finishedAt = typeof manifest.finishedAt === 'string' ? Date.parse(manifest.finishedAt) : Number.NaN
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    throw new Error('run manifest startedAt/finishedAt must be a valid ordered evidence window')
  }
  if (manifest.workers !== 5) throw new Error('run manifest workers must be exactly 5')
  if (manifest.retries !== 0) throw new Error('run manifest retries must be exactly 0')
  if (!Array.isArray(manifest.deviations) || manifest.deviations.length !== 0) throw new Error('deviation list must be empty')
  if (!Array.isArray(manifest.allowedRejections) || manifest.allowedRejections.length !== 0) throw new Error('H rejection list must be empty')

  const cost = manifest.cost ?? {}
  if (typeof cost.upstreamUsdSpent !== 'number' || cost.upstreamUsdSpent < 0 || cost.upstreamUsdSpent >= MAX_UPSTREAM_USD) {
    throw new Error(`upstream cost must be >= 0 and < $${MAX_UPSTREAM_USD}`)
  }
  if (typeof cost.subscriptionWindowPercentUsed !== 'number' || cost.subscriptionWindowPercentUsed < 0 || cost.subscriptionWindowPercentUsed >= MAX_SUBSCRIPTION_PERCENT) {
    throw new Error(`subscription window usage must be >= 0 and < ${MAX_SUBSCRIPTION_PERCENT}%`)
  }
  const costFiles = [
    requireFile(root, cost.beforePath, 'cost.beforePath'),
    requireFile(root, cost.afterPath, 'cost.afterPath'),
  ]

  const mutationProofs = Array.isArray(manifest.mutationProofs) ? manifest.mutationProofs : []
  const defects = mutationProofs.map((proof) => proof?.defect).sort((a, b) => a - b)
  if (JSON.stringify(defects) !== JSON.stringify([1, 2, 3])) throw new Error('mutation proofs must cover exactly defects 1, 2, and 3')
  const mutationFiles = []
  for (const reference of mutationProofs) {
    const proofPath = requireFile(root, reference.path, `mutation defect ${reference.defect} path`)
    const proof = readJson(proofPath, `mutation defect ${reference.defect}`)
    if (proof.format !== MUTATION_FORMAT || proof.defect !== reference.defect || proof.baseCommit !== head) {
      throw new Error(`mutation defect ${reference.defect} identity is invalid`)
    }
    if (!Number.isInteger(proof.exitCode) || proof.exitCode === 0 || proof.matchedAssertion !== true) {
      throw new Error(`mutation defect ${reference.defect} did not prove a red assertion`)
    }
    mutationFiles.push(proofPath, requireFile(root, proof.logPath, `mutation defect ${reference.defect} logPath`))
  }

  const gateFiles = []
  for (const gate of REQUIRED_GATES) {
    const value = manifest.gates?.[gate]
    if (value?.status !== 'pass' || value?.head !== head) throw new Error(`${gate} gate is not PASS on ${head}`)
    const gatePath = requireFile(root, value.logPath, `${gate} gate logPath`)
    gateFiles.push(gatePath)
  }
  return { costFiles, mutationFiles, gateFiles, startedAt, finishedAt }
}

export function validateEvidence({ evidenceDir, head }) {
  const requestedRoot = resolve(evidenceDir)
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) throw new Error(`evidence directory is missing: ${requestedRoot}`)
  const root = realpathSync(requestedRoot)
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`head must be a full 40-character commit SHA: ${head}`)
  const manifestPath = resolve(root, 'run-manifest.json')
  const manifest = readJson(manifestPath, 'run-manifest.json')
  const manifestEvidence = validateManifest(root, manifest, head)
  const discovered = discoverCellRecords(root)
  const expectedKeys = new Set(EXPECTED_CELLS.map(keyOf))
  for (const key of discovered.keys()) {
    if (!expectedKeys.has(key)) throw new Error(`unexpected cell record ${key}`)
  }

  const cells = []
  for (const expected of EXPECTED_CELLS) {
    const key = keyOf(expected)
    const record = discovered.get(key)
    if (!record) throw new Error(`missing cell record ${key}`)
    if (record.commit !== head) throw new Error(`${key} commit ${record.commit ?? 'missing'} does not match ${head}`)
    if (record.model !== expected.model) throw new Error(`${key} model ${record.model ?? 'missing'} does not match ${expected.model}`)
    const recordedAt = Date.parse(record.recordedAt)
    if (typeof record.recordedAt !== 'string' || !Number.isFinite(recordedAt)) {
      throw new Error(`${key} recordedAt is missing or invalid`)
    }
    if (recordedAt < manifestEvidence.startedAt || recordedAt > manifestEvidence.finishedAt) {
      throw new Error(`${key} was recorded outside the manifest evidence window`)
    }
    if (!record.observations || typeof record.observations !== 'object' || Array.isArray(record.observations) || Object.keys(record.observations).length === 0) {
      throw new Error(`${key} observations are missing or empty`)
    }
    validateVerdict(expected, record)
    const artifacts = validateCellArtifacts(root, expected, record)
    cells.push({ expected, record, artifacts })
  }

  for (const chain of MATRIX_CHAINS) {
    validateHRecord(chain, discovered.get(`${chain.id}/H`))
  }
  const multiplierModels = new Set(MATRIX_CHAINS.map((chain) => chain.model))
  if (multiplierModels.size !== 5) throw new Error('matrix must cover exactly five unique multiplier models')

  return { root, head, manifest, manifestPath, cells, manifestEvidence }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function hrefFor(outputPath, artifactPath) {
  const rel = relative(dirname(outputPath), artifactPath).split(sep).join('/')
  return escapeHtml(rel.startsWith('.') ? rel : `./${rel}`)
}

function artifactLinks(outputPath, paths) {
  return paths.map((path) => `<a href="${hrefFor(outputPath, path)}">${escapeHtml(relative(dirname(outputPath), path).split(sep).join('/'))}</a>`).join('<br>')
}

export function renderReport(validation, outputPath) {
  const rows = validation.cells.map(({ expected, record, artifacts }) => `
    <tr>
      <td>${escapeHtml(expected.chain)}</td>
      <td>${escapeHtml(expected.cell)}</td>
      <td>${escapeHtml(record.model)}</td>
      <td><span class="status">${escapeHtml(record.verdict.toUpperCase())}</span></td>
      <td>${artifactLinks(outputPath, artifacts)}</td>
    </tr>`).join('')
  const multiplierRows = [...new Map(MATRIX_CHAINS.map((chain) => [chain.model, chain])).values()]
    .map((chain) => {
      const h = validation.cells.find(({ expected }) => expected.chain === chain.id && expected.cell === 'H')
      return `<tr><td>${escapeHtml(chain.model)}</td><td>×${chain.multiplier}</td><td>${artifactLinks(outputPath, [h.record.sourcePath])}</td></tr>`
    }).join('')
  const manifest = validation.manifest
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>#2503 最终行为矩阵</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #202124; background: #f7f8fa; }
    body { margin: 0; }
    header, main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0 18px; border-bottom: 1px solid #d8dde5; }
    h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
    h2 { margin: 28px 0 10px; font-size: 17px; letter-spacing: 0; }
    p { margin: 6px 0; line-height: 1.55; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
    .ready { display: inline-block; padding: 4px 8px; border: 1px solid #238636; border-radius: 4px; color: #116329; background: #eaf7ed; font-weight: 700; }
    .meta { color: #5f6672; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: 12px; }
    th, td { padding: 8px 10px; border: 1px solid #d8dde5; text-align: left; vertical-align: top; }
    th { background: #eef1f5; font-weight: 650; }
    tr:nth-child(even) td { background: #fafbfc; }
    a { color: #0969da; overflow-wrap: anywhere; }
    .status { color: #116329; font-weight: 700; }
    footer { margin: 28px 0 40px; padding-top: 12px; border-top: 1px solid #d8dde5; color: #5f6672; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <span class="ready">READY</span>
    <h1>#2503 端到端行为矩阵</h1>
    <p class="meta">HEAD <code>${escapeHtml(validation.head)}</code> · ${validation.cells.length} 个直接证据格 · 5 个唯一倍率 · workers=5 · retries=0</p>
    <p class="meta">上游成本 $${escapeHtml(manifest.cost.upstreamUsdSpent)} · 订阅窗消耗 ${escapeHtml(manifest.cost.subscriptionWindowPercentUsed)}%</p>
  </header>
  <main>
    <h2>逐格证据</h2>
    <table><thead><tr><th>链</th><th>格</th><th>模型</th><th>结果</th><th>可回放证据</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>倍率正确性</h2>
    <table><thead><tr><th>模型</th><th>目录倍率</th><th>H 面证据</th></tr></thead><tbody>${multiplierRows}</tbody></table>
    <h2>运行闸门</h2>
    <table><thead><tr><th>闸门</th><th>结果</th><th>日志</th></tr></thead><tbody>${REQUIRED_GATES.map((gate) => `<tr><td>${gate}</td><td><span class="status">PASS</span></td><td>${artifactLinks(outputPath, [resolve(validation.root, manifest.gates[gate].logPath)])}</td></tr>`).join('')}</tbody></table>
    <h2>反例与成本</h2>
    <p>#1/#2/#3 mutation 均观察到目标断言变红；偏离清单与 H 拒绝清单均为空。</p>
    <p>${artifactLinks(outputPath, [...validation.manifestEvidence.mutationFiles, ...validation.manifestEvidence.costFiles])}</p>
    <footer>由 scripts/matrix-2503-report.mjs 从原始证据机械生成；任何缺格、旧提交、越权 waiver、缺录屏或越界成本都会拒绝生成本页。</footer>
  </main>
</body>
</html>`
}

export function generateReport({ evidenceDir, output, head }) {
  const validation = validateEvidence({ evidenceDir, head })
  const requestedOutputPath = resolve(output)
  if (!requestedOutputPath.endsWith('.html')) throw new Error('report output must use the .html extension')
  const requestedOutputParent = dirname(requestedOutputPath)
  if (!existsSync(requestedOutputParent) || !statSync(requestedOutputParent).isDirectory()) {
    throw new Error('report output directory is missing')
  }
  const outputParent = realpathSync(requestedOutputParent)
  if (!isInside(validation.root, outputParent)) {
    throw new Error('report output directory resolves outside the evidence directory')
  }
  if (existsSync(requestedOutputPath) && !isInside(validation.root, realpathSync(requestedOutputPath))) {
    throw new Error('report output resolves outside the evidence directory')
  }
  const outputPath = resolve(outputParent, basename(requestedOutputPath))
  writeFileSync(outputPath, `${renderReport(validation, outputPath)}\n`)
  return { outputPath, cells: validation.cells.length, head }
}

function currentHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'evidence-dir': { type: 'string' },
      output: { type: 'string' },
      head: { type: 'string' },
    },
    strict: true,
  })
  if (!values['evidence-dir'] || !values.output) {
    throw new Error('usage: node scripts/matrix-2503-report.mjs --evidence-dir <dir> --output <dir/report.html> [--head <sha>]')
  }
  const result = generateReport({
    evidenceDir: values['evidence-dir'],
    output: values.output,
    head: values.head ?? currentHead(),
  })
  process.stdout.write(`matrix report READY: ${result.cells} cells; head=${result.head}; output=${result.outputPath}\n`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`matrix report refused: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
