#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import picomatch from 'picomatch'
import ts from 'typescript'

/** Parsed workflow YAML / manifest / reporter JSON: untyped input, validated where each field is read. */
type Parsed = ReturnType<typeof JSON.parse>

export interface CoverageManifestGroup {
  id: string
  workflow?: string
  job?: string
  requiredGate?: string
}

export interface CoverageManifest {
  version: number
  automaticExecutors: CoverageManifestGroup[]
  exemptionReasons: Record<string, string>
  exemptions: Record<string, string>
}

export interface CoverageAuditResult {
  discovered: string[]
  errors: string[]
  groupCounts: Array<{
    id: string
    disposition: string
    count: number
    reason?: string
  }>
}

export interface WorkflowEntry {
  path: string
  workflow: Parsed
}

export interface RunnerCommand {
  runner: 'vitest' | 'playwright'
  args: string[]
  workflow: string
  job: string
  env: Record<string, string>
}

export interface ChangedSpecExecutionResult {
  candidates: string[]
  commands: RunnerCommand[]
  executed: string[]
  gaps: string[]
}

type RawRunnerCommand = Pick<RunnerCommand, 'runner' | 'args'>
type ParsedSource = ts.SourceFile & { parseDiagnostics: ts.DiagnosticWithLocation[] }

const TEST_ROOTS = ['tests/e2e', 'tests/integration']
export const NO_NEW_E2E: string = '❌ 不再新增 e2e 用例;验收证据写成单元测试(必要时把被测逻辑重构成可注入依赖的纯函数)。'
  + 'tests/e2e/ 只留 PR CI 的 ci-local 真跑的那几条,且不接受豁免(#6270)'
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/
const DECLARATION_PROPERTIES = new Set(['describe', 'each', 'fixme', 'only', 'skip'])
// eslint-disable-next-line no-control-regex -- 这条正则的**用途**就是剥 ANSI 转义序列,\x1B 是它的本分
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const PLAYWRIGHT_STDOUT_TAIL_CHARS = 480

function isTestModule(moduleName: string): boolean {
  return moduleName === 'vitest'
    || moduleName === '@playwright/test'
    || /(?:^|\/)support\/(?:agent-runtime|test)$/.test(moduleName)
}

function propertyChain(expression: ts.Expression): { root: string; properties: string[] } | null {
  const properties: string[] = []
  let current = expression
  while (ts.isPropertyAccessExpression(current)) {
    properties.unshift(current.name.text)
    current = current.expression
  }
  return ts.isIdentifier(current) ? { root: current.text, properties } : null
}

function analyzeTestSource(sourceText: string, filePath: string): { declaresTest: boolean; relativeImports: string[] } {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true) as ParsedSource
  if (source.parseDiagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')
    throw new Error(`cannot parse ${filePath}: ${detail}`)
  }

  const callableImports = new Set<string>()
  const namespaceImports = new Set<string>()
  const relativeImports: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const moduleName = statement.moduleSpecifier.text
    if (moduleName.startsWith('.')) relativeImports.push(moduleName)
    if (!isTestModule(moduleName)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text
        if (imported === 'test' || imported === 'it') callableImports.add(binding.name.text)
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceImports.add(bindings.name.text)
    }
  }

  let found = false
  function visit(node: ts.Node): void {
    if (found) return
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression)
      if (chain && callableImports.has(chain.root)) {
        if (chain.properties.length === 0 || DECLARATION_PROPERTIES.has(chain.properties[0])) found = true
      }
      if (chain && namespaceImports.has(chain.root)) {
        if (chain.properties.some((part) => part === 'test' || part === 'it')) found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { declaresTest: found, relativeImports }
}

export function declaresTestCase(sourceText: string, filePath: string): boolean {
  return analyzeTestSource(sourceText, filePath).declaresTest
}

export function listTrackedSources(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...TEST_ROOTS], { cwd: root })
  return output.toString('utf8').split('\0').filter(Boolean).filter((file) => SOURCE_EXTENSION.test(file))
}

export function discoverSpecFiles({ root, trackedPaths = listTrackedSources(root) }: { root: string; trackedPaths?: string[] }): string[] {
  const analyses = new Map<string, { declaresTest: boolean; relativeImports: string[] }>()
  const sourcePaths = trackedPaths.filter((file) => {
    return TEST_ROOTS.some((testRoot) => file === testRoot || file.startsWith(`${testRoot}/`))
      && SOURCE_EXTENSION.test(file)
  })
  const trackedSet = new Set(sourcePaths)
  for (const file of sourcePaths) {
    const sourceText = readFileSync(path.join(root, file), 'utf8')
    analyses.set(file, analyzeTestSource(sourceText, file))
  }

  const discovered = new Set([...analyses].filter(([, analysis]) => analysis.declaresTest).map(([file]) => file))
  function resolveImport(importer: string, moduleName: string): string | undefined {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), moduleName))
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map((extension) => `${base}${extension}`)]
    return candidates.find((candidate) => trackedSet.has(candidate))
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [file, analysis] of analyses) {
      if (discovered.has(file)) continue
      if (analysis.relativeImports.some((moduleName) => discovered.has(resolveImport(file, moduleName)!))) {
        discovered.add(file)
        changed = true
      }
    }
  }
  return [...discovered].sort()
}

export function isChangedExecutionCandidate(file: string): boolean {
  return (file.startsWith('tests/e2e/') && file.endsWith('.spec.ts'))
    || file.startsWith('tests/integration/')
}

export function listChangedPaths(root: string, base: string, head: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', '-z', base, head],
    { cwd: root },
  )
  return output.toString('utf8').split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'))
}

function orderedPathMatch(file: string, patterns: unknown[]): boolean {
  let matched = false
  for (const entry of patterns) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`workflow path filter contains invalid pattern ${JSON.stringify(entry)}`)
    }
    const negated = entry.startsWith('!')
    const pattern = negated ? entry.slice(1) : entry
    if (picomatch.isMatch(file, pattern, { dot: true })) matched = !negated
  }
  return matched
}

function triggerConfig(workflow: Parsed, eventName: string): Parsed {
  const trigger = workflow?.on
  if (typeof trigger === 'string') return trigger === eventName ? {} : undefined
  if (Array.isArray(trigger)) return trigger.includes(eventName) ? {} : undefined
  if (!trigger || typeof trigger !== 'object' || !(eventName in trigger)) return undefined
  return trigger[eventName] ?? {}
}

// 这里**没有**改动文件数量的上限,也不需要:`changedPaths` 默认来自 listChangedPaths(),
// 那是本地 `git diff --name-only`,拿到的永远是全量。
//
// 从前这里在超过 300 个文件时直接抛错,理由写的是「GitHub 的 API 最多列 300 个」。这条护栏是
// 错的,而且拦死了真活:它守的既不是本函数的输入(本地 git diff 没有任何上限),也不是 GitHub
// 现在的行为 —— 300 是 GitHub **早已提高**的旧限额,现在的 PR files API 上限是 3000
// (REST 文档:"Responses include a maximum of 3000 files")。实证:dev → main 的 promotion
// (#3198)改了 1585 个文件,`schema-baseline.yml` 过滤 `supabase/migrations/**` 而第一个匹配
// 文件排在第 1349 位 —— GitHub 照样触发了它(两次 run 均 success)。
//
// 后果是任何超过 300 文件的 PR 都跑不了这项检查:#3198 的覆盖率判定本身已经通过,却被这一句
// 拖红,而 CLAUDE.md 规定放行只认 CI 裁决,等于把发布路径锁死。
//
// ❌ 别在这里改成「算不准就按会触发处理」之类的降级:那是拿一个不存在的截断去换真实的判定精度,
// 而判「会触发」会把更多命令收进自动执行集合,让覆盖率检查在改动面最大的 PR 上失守。
export function workflowRunsForPullRequest(
  workflow: Parsed,
  changedPaths: string[],
  baseRef = 'dev',
  eventAction = 'synchronize',
): boolean {
  const pullRequest = triggerConfig(workflow, 'pull_request')
  if (pullRequest === undefined) return false
  if (!pullRequest || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
    throw new Error('pull_request trigger must be an object or null')
  }

  if (pullRequest.types !== undefined) {
    if (!Array.isArray(pullRequest.types)
      || pullRequest.types.length === 0
      || pullRequest.types.some((type: unknown) => typeof type !== 'string' || type.length === 0)) {
      throw new Error('pull_request types must be a non-empty string array')
    }
    if (!pullRequest.types.includes(eventAction)) return false
  }
  if (pullRequest.branches && !orderedPathMatch(baseRef, pullRequest.branches)) return false
  if (pullRequest['branches-ignore'] && orderedPathMatch(baseRef, pullRequest['branches-ignore'])) return false

  if (pullRequest.paths
    && !changedPaths.some((file) => orderedPathMatch(file, pullRequest.paths))) return false
  if (pullRequest['paths-ignore']
    && changedPaths.every((file) => orderedPathMatch(file, pullRequest['paths-ignore']))) return false
  return true
}

function shellWords(value: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  let escaped = false
  let active = false
  for (const character of value.trim()) {
    if (escaped) {
      word += character
      escaped = false
      active = true
    } else if (character === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else word += character
      active = true
    } else if (character === "'" || character === '"') {
      quote = character
      active = true
    } else if (/\s/.test(character)) {
      if (active) {
        words.push(word)
        word = ''
        active = false
      }
    } else {
      word += character
      active = true
    }
  }
  if (escaped || quote) throw new Error(`cannot parse shell arguments: ${value}`)
  if (active) words.push(word)
  return words
}

function extractRunnerCommands(
  run: string,
  packageScripts: Record<string, string>,
  seenScripts: Set<string> = new Set(),
): RawRunnerCommand[] {
  const normalized = run.replace(/\\\r?\n\s*/g, ' ')
  const mentionsRunner = /\b(?:vitest\s+run|playwright\s+test)\b/.test(normalized)
    || Object.entries(packageScripts).some(([name, script]) => {
      return /\b(?:vitest\s+run|playwright\s+test)\b/.test(script)
        && new RegExp(`(?:^|\\s)pnpm\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(normalized)
    })
  if (!mentionsRunner) return []
  const commands: RawRunnerCommand[] = []
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const unrecognized: string[] = []
  for (const line of lines) {
    const words = shellWords(line)
    // @@@ci-concurrent (#6270) — 一个 step 里并发跑几条命令:每条 lane 是 `label=command`,
    // 各自按同一套规则递归认领。认不出的 lane 形状当场报错,❌ 不许让它藏住一条 runner。
    if (words[0] === 'node' && words[1] === 'scripts/ci/ci-concurrent.mts') {
      const lanes = words.slice(2)
      if (lanes.length === 0) throw new Error(`ci-concurrent step has no lanes: ${line}`)
      for (const lane of lanes) {
        const eq = lane.indexOf('=')
        if (eq <= 0 || eq === lane.length - 1) throw new Error(`ci-concurrent lane is not label=command: ${lane}`)
        commands.push(...extractRunnerCommands(lane.slice(eq + 1), packageScripts, seenScripts))
      }
      continue
    }
    const offset = words[0] === 'pnpm' && words[1] === 'exec' ? 2 : 0
    const runner: RawRunnerCommand['runner'] | undefined = words[offset] === 'vitest' && words[offset + 1] === 'run'
      ? 'vitest'
      : words[offset] === 'playwright' && words[offset + 1] === 'test'
        ? 'playwright'
        : undefined
    if (runner) {
      const args = words.slice(offset + 2)
      if (args.some((argument) => /[;&|<>]/.test(argument))) {
        throw new Error(`runner command contains unsupported shell control syntax: ${line}`)
      }
      commands.push({ runner, args })
      continue
    }

    const scriptName = words[0] === 'pnpm' && /^[A-Za-z][\w:-]*$/.test(words[1] ?? '') ? words[1] : undefined
    if (scriptName && scriptName in packageScripts && !seenScripts.has(scriptName)) {
      const appendedArgs = words.slice(2)
      if (appendedArgs.some((argument) => /[;&|<>]/.test(argument))) {
        throw new Error(`package script command contains unsupported shell control syntax: ${line}`)
      }
      const nextSeen = new Set(seenScripts).add(scriptName)
      commands.push(...extractRunnerCommands(
        `${packageScripts[scriptName]}${appendedArgs.length > 0 ? ` ${appendedArgs.join(' ')}` : ''}`,
        packageScripts,
        nextSeen,
      ))
      continue
    }
    unrecognized.push(line)
  }
  if (commands.length > 0 && unrecognized.length > 0) {
    throw new Error(`runner step contains unsupported shell statements: ${unrecognized.join(' | ')}`)
  }
  if (commands.length === 0 && unrecognized.some((line) => /\b(?:vitest\s+run|playwright\s+test)\b/.test(line))) {
    throw new Error(`runner text is not a provably executed command: ${unrecognized.join(' | ')}`)
  }

  return commands.filter((command, index, all) => {
    const key = `${command.runner}\0${command.args.join('\0')}`
    return all.findIndex((candidate) => `${candidate.runner}\0${candidate.args.join('\0')}` === key) === index
  })
}

function matrixAssignments(job: Parsed, label: string): Record<string, unknown>[] {
  const matrix = job?.strategy?.matrix
  if (matrix === undefined) return [{}]
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new Error(`${label} matrix must be a static object`)
  }
  if (matrix.exclude !== undefined) {
    throw new Error(`${label} matrix exclude cannot be reliably expanded`)
  }
  if (matrix.include !== undefined) {
    const axes = Object.keys(matrix).filter((key) => key !== 'include')
    if (axes.length > 0) {
      throw new Error(`${label} matrix cannot mix include with cartesian axes`)
    }
    if (!Array.isArray(matrix.include) || matrix.include.length === 0) {
      throw new Error(`${label} matrix include must be a non-empty array`)
    }
    return matrix.include.map((assignment: Parsed, index: number) => {
      if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
        throw new Error(`${label} matrix include[${index}] must be a static object`)
      }
      for (const [name, value] of Object.entries(assignment)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new Error(`${label} matrix include[${index}].${name} must be a scalar`)
        }
      }
      return assignment
    })
  }
  let assignments: Record<string, unknown>[] = [{}]
  for (const [name, values] of Object.entries(matrix)) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
      throw new Error(`${label} matrix ${name} must be a non-empty scalar array`)
    }
    assignments = assignments.flatMap((assignment) => values.map((value) => ({ ...assignment, [name]: value })))
  }
  return assignments
}

function applyMatrix(run: string, assignment: Record<string, unknown>, label: string): string {
  const expanded = run.replace(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g, (_, name: string) => {
    if (!(name in assignment)) throw new Error(`${label} references unknown matrix key ${name}`)
    return String(assignment[name])
  })
  return expanded
}

function resolvedEnvironment(assignment: Record<string, unknown>, label: string, ...sources: Parsed[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [name, value] of Object.entries(source)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`${label} env ${name} must be a scalar`)
      }
      const expanded = applyMatrix(String(value), assignment, `${label} env ${name}`)
      if (expanded.includes('${{')) throw new Error(`${label} env ${name} cannot be resolved statically`)
      result[name] = expanded
    }
  }
  return result
}

export function collectAutomaticRunnerCommands({
  workflows,
  changedPaths,
  packageScripts,
  baseRef = 'dev',
  eventAction = 'synchronize',
}: {
  workflows: WorkflowEntry[]
  changedPaths: string[]
  packageScripts: Record<string, string>
  baseRef?: string
  eventAction?: string
}): RunnerCommand[] {
  const commands: RunnerCommand[] = []
  for (const entry of workflows) {
    if (!workflowRunsForPullRequest(entry.workflow, changedPaths, baseRef, eventAction)) continue
    for (const [jobId, job] of Object.entries<Parsed>(entry.workflow.jobs ?? {})) {
      for (const [stepIndex, step] of (job.steps ?? []).entries() as IterableIterator<[number, Parsed]>) {
        if (typeof step.run !== 'string') continue
        const rawCommands = extractRunnerCommands(step.run, packageScripts)
        if (rawCommands.length === 0) continue
        const label = `${entry.path} job ${jobId} step ${stepIndex + 1}`
        if (job.if !== undefined || step.if !== undefined) {
          throw new Error(`${label} condition prevents reliable execution derivation`)
        }
        const workingDirectory = step['working-directory']
          ?? job.defaults?.run?.['working-directory']
          ?? entry.workflow.defaults?.run?.['working-directory']
        if (workingDirectory !== undefined) {
          throw new Error(`${label} working-directory prevents reliable execution derivation`)
        }
        for (const assignment of matrixAssignments(job, `${entry.path} job ${jobId}`)) {
          const expandedRun = applyMatrix(step.run, assignment, label)
          for (const command of extractRunnerCommands(expandedRun, packageScripts)) {
            if (command.args.some((argument) => /\$(?:\{?[A-Za-z_]|\()/.test(argument))) {
              throw new Error(`${label} has dynamic runner arguments that cannot be collected reliably`)
            }
            commands.push({
              ...command,
              workflow: entry.path,
              job: jobId,
              env: resolvedEnvironment(assignment, label, entry.workflow.env, job.env, step.env),
            })
          }
        }
      }
    }
  }
  return commands.filter((command, index, all) => {
    const key = `${command.runner}\0${command.args.join('\0')}\0${JSON.stringify(command.env)}`
    return all.findIndex((candidate) => {
      return `${candidate.runner}\0${candidate.args.join('\0')}\0${JSON.stringify(candidate.env)}` === key
    }) === index
  })
}

function withoutOption(args: string[], option: string, takesValue = true): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) {
      if (takesValue) index += 1
      continue
    }
    if (!args[index].startsWith(`${option}=`)) result.push(args[index])
  }
  return result
}

function repoRelative(root: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
  if (relative === '..' || relative.startsWith('../')) throw new Error(`runner collected file outside repository: ${file}`)
  return relative
}

export function parseVitestList(root: string, output: string): string[] {
  const files: string[] = []
  for (const line of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const match = /^\[[^\]]+\]\s+(.+)$/.exec(line.trim())
    if (match) files.push(repoRelative(root, match[1]))
  }
  return [...new Set(files)].sort()
}

// 报告前面可能还有别的东西。pnpm 的 engine 警告就写在 **stdout**,而且正文里带着一个 JSON 对象:
//   WARN  Unsupported engine: wanted: {"node":">=24.0.0"} (current: {...})
// 于是 indexOf('{') 落在 {"node":">=24.0.0"} 上,它自己是一段合法 JSON,解析完再撞上后面的
// ` (current: ...` —— 报错成 "Unexpected non-whitespace character after JSON at position 20"。
// 逐个候选起点试到能解析出带 config 的那个,不要认第一个 '{'。
function parseFirstJsonObject(output: string): Parsed {
  let lastError: unknown
  for (let i = output.indexOf('{'); i !== -1; i = output.indexOf('{', i + 1)) {
    try {
      const parsed = JSON.parse(output.slice(i))
      if (parsed && typeof parsed === 'object' && parsed.config) return parsed
    } catch (error) { lastError = error }
  }
  throw lastError ?? new Error('no JSON object with a config field')
}

export function parsePlaywrightList(root: string, output: string): string[] {
  if (output.indexOf('{') === -1) throw new Error('Playwright JSON reporter did not emit a JSON object')
  let report: Parsed
  try {
    report = parseFirstJsonObject(output)
  } catch (error) {
    const tail = output.slice(-PLAYWRIGHT_STDOUT_TAIL_CHARS)
    const omitted = output.length - tail.length
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Playwright JSON reporter emitted invalid output: ${detail}; `
      + `stdout tail (${tail.length}/${output.length} chars, ${omitted} omitted): ${JSON.stringify(tail)}`,
    )
  }
  const rootDir = report?.config?.rootDir
  if (typeof rootDir !== 'string') throw new Error('Playwright JSON reporter omitted config.rootDir')
  const files = new Set<string>()
  function visitSuite(suite: Parsed): void {
    for (const spec of suite?.specs ?? []) {
      if (typeof spec?.file === 'string' && Array.isArray(spec.tests) && spec.tests.length > 0) {
        files.add(repoRelative(root, path.resolve(rootDir, spec.file)))
      }
    }
    for (const child of suite?.suites ?? []) visitSuite(child)
  }
  for (const suite of report.suites ?? []) visitSuite(suite)
  return [...files].sort()
}

export function collectRunnerFiles(root: string, command: RunnerCommand): string[] {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const env = { ...process.env, ...command.env, FORCE_COLOR: '0' }
  try {
    if (command.runner === 'vitest') {
      const args = withoutOption(command.args, '--reporter')
      const output = execFileSync(pnpm, ['exec', 'vitest', 'list', ...args, '--filesOnly'], {
        cwd: root,
        env,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
      return parseVitestList(root, output)
    }
    const args = withoutOption(withoutOption(command.args, '--reporter'), '--list', false)
    // stdout 是共享信道:链路上任何一环(pnpm、node、shell profile)都能往里写。
    // 让 Playwright 把报告写进独立文件,读文件而不是读 stdout —— 这一整类污染就没有入口了。
    const reportDir = mkdtempSync(path.join(tmpdir(), 'gugu-spec-coverage-'))
    const reportFile = path.join(reportDir, 'playwright-list.json')
    try {
      execFileSync(pnpm, ['exec', 'playwright', 'test', ...args, '--list', '--reporter=json'], {
        cwd: root,
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
      if (!existsSync(reportFile)) {
        throw new Error(`Playwright JSON reporter wrote no file at ${reportFile}`)
      }
      return parsePlaywrightList(root, readFileSync(reportFile, 'utf8'))
    } finally {
      rmSync(reportDir, { recursive: true, force: true })
    }
  } catch (error) {
    throw new Error(`cannot collect ${command.runner} files for ${command.workflow} job ${command.job}: ${(error as Error).message}`)
  }
}

// @@@parallel-listing (#6270) — 每条 runner 命令都要起一次 `vitest list` / `playwright test --list`,每次 4–6s。
// 串着跑时这一步随命令条数线性变长:session-db 拆成并发 lane、tooling 并进来之后,PR 上从 5s 涨到 25–40s,
// 成了 policy 这个关键路径 job 里最长的一步。列表之间互不依赖 ⇒ 并发跑,结果按原顺序拼回。
// 每条命令仍由**同一个** collectRunnerFiles 在独立子进程里执行,判据一行没改,只是不再排队。
const SELF = fileURLToPath(import.meta.url)

export function collectRunnerFilesMany(root: string, commands: RunnerCommand[]): string[][] {
  if (commands.length <= 1) return commands.map((command) => collectRunnerFiles(root, command))
  // 参数经文件传,❌ 不用同步 spawn 的 `input`(macOS 上会间歇性挂死,#3766 / .eslintrc.cjs @@@spawnsync-input)。
  const requestDir = mkdtempSync(path.join(tmpdir(), 'gugu-spec-coverage-batch-'))
  const requestFile = path.join(requestDir, 'request.json')
  try {
    writeFileSync(requestFile, JSON.stringify({ root, commands }))
    const output = execFileSync(process.execPath, [SELF, '--internal-collect-many', requestFile], {
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    return JSON.parse(output).map((result: { error?: string; files?: string[] }) => {
      if (result.error) throw new Error(result.error)
      return result.files!
    })
  } finally {
    rmSync(requestDir, { recursive: true, force: true })
  }
}

async function internalCollectMany(requestFile: string): Promise<void> {
  const { root, commands }: { root: string; commands: RunnerCommand[] } = JSON.parse(readFileSync(requestFile, 'utf8'))
  const results = await Promise.all(commands.map((command) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, '--internal-collect-one'], { stdio: ['pipe', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', (error) => resolve({ error: error.message }))
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve({ error: `collector child exited ${code} without a result for ${command.workflow} job ${command.job}` })
      }
    })
    child.stdin.end(JSON.stringify({ root, command }))
  })))
  process.stdout.write(JSON.stringify(results))
}

function internalCollectOne(): void {
  const { root, command } = JSON.parse(readFileSync(0, 'utf8'))
  try {
    process.stdout.write(JSON.stringify({ files: collectRunnerFiles(root, command) }))
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }))
  }
}

function readWorkflows(root: string): WorkflowEntry[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'], { cwd: root })
  const YAML = createRequire(import.meta.url)('yaml')
  return output.toString('utf8').split('\0').filter(Boolean).map((workflowPath) => ({
    path: workflowPath,
    workflow: YAML.parse(readFileSync(path.join(root, workflowPath), 'utf8')),
  }))
}

export function auditChangedSpecExecution({
  root,
  base,
  head,
  baseRef = 'dev',
  eventAction = 'synchronize',
  changedPaths = listChangedPaths(root, base!, head!),
  workflows = readWorkflows(root),
  packageScripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {},
  collectFiles = collectRunnerFiles,
}: {
  root: string
  base?: string
  head?: string
  baseRef?: string
  eventAction?: string
  changedPaths?: string[]
  workflows?: WorkflowEntry[]
  packageScripts?: Record<string, string>
  collectFiles?: (root: string, command: RunnerCommand) => string[]
}): ChangedSpecExecutionResult {
  const candidates = changedPaths.filter(isChangedExecutionCandidate).sort()
  if (candidates.length === 0) return { candidates, commands: [], executed: [], gaps: [] }
  const commands = collectAutomaticRunnerCommands({ workflows, changedPaths, packageScripts, baseRef, eventAction })
  const executed = new Set<string>()
  const perCommand = collectFiles === collectRunnerFiles
    ? collectRunnerFilesMany(root, commands)
    : commands.map((command) => collectFiles(root, command))
  for (const files of perCommand) {
    for (const file of files) executed.add(file)
  }
  const gaps = candidates.filter((file) => !executed.has(file))
  return { candidates, commands, executed: [...executed].sort(), gaps }
}

function assertArray(value: unknown, label: string, errors: string[]): Parsed[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return []
  }
  return value
}

function assertRecord(value: unknown, label: string, errors: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`)
    return {}
  }
  return value as Record<string, unknown>
}

function validateWorkflowExecutor(
  root: string,
  executor: Parsed,
  errors: string[],
  collectExecutorFiles: (root: string, commands: RunnerCommand[]) => string[],
): string[] {
  const label = `automatic executor ${executor.id ?? '(missing id)'}`
  for (const field of ['id', 'workflow', 'job', 'requiredGate']) {
    if (typeof executor[field] !== 'string' || executor[field].trim() === '') {
      errors.push(`${label} requires non-empty ${field}`)
    }
  }
  if (errors.some((error) => error.startsWith(label))) return []

  const workflowPath = path.join(root, executor.workflow)
  let workflow: Parsed
  try {
    const YAML = createRequire(import.meta.url)('yaml')
    workflow = YAML.parse(readFileSync(workflowPath, 'utf8'))
  } catch (error) {
    errors.push(`${label} cannot read workflow ${executor.workflow}: ${(error as Error).message}`)
    return []
  }

  const pullRequest = workflow?.on?.pull_request
  if (pullRequest === undefined) errors.push(`${label} workflow is not triggered by pull_request`)
  if (pullRequest && (pullRequest.paths || pullRequest['paths-ignore'])) {
    errors.push(`${label} workflow pull_request trigger is path-filtered`)
  }

  const job = workflow?.jobs?.[executor.job]
  if (!job) {
    errors.push(`${label} workflow has no job ${executor.job}`)
    return []
  }
  if (job.if !== undefined) errors.push(`${label} job has an if condition and is not unconditional`)
  if (job['continue-on-error'] !== undefined) errors.push(`${label} job uses continue-on-error`)
  const packageScripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {}
  const runnerSteps = (job.steps ?? []).filter((step: Parsed) => {
    return typeof step.run === 'string' && extractRunnerCommands(step.run, packageScripts).length > 0
  })
  if (runnerSteps.length === 0) errors.push(`${label} job contains no static test runner command`)
  for (const step of runnerSteps) {
    if (step.if !== undefined) errors.push(`${label} runner step has an if condition`)
    if (step['continue-on-error'] !== undefined) errors.push(`${label} runner step uses continue-on-error`)
  }

  const requiredGate = workflow?.jobs?.[executor.requiredGate]
  if (!requiredGate) {
    errors.push(`${label} workflow has no required gate ${executor.requiredGate}`)
    return []
  }
  const visited = new Set<string>()
  function requiredDependencies(jobId: string): boolean {
    if (visited.has(jobId)) return false
    visited.add(jobId)
    const current = workflow.jobs[jobId]
    const needs = typeof current?.needs === 'string' ? [current.needs] : (current?.needs ?? [])
    return needs.includes(executor.job) || needs.some(requiredDependencies)
  }
  if (!requiredDependencies(executor.requiredGate)) {
    errors.push(`${label} job is not a dependency of required gate ${executor.requiredGate}`)
  }
  const rejection = `[ "\${{ needs.${executor.job}.result }}" != "success" ]`
  const rejectsNonSuccess = (requiredGate.steps ?? []).some((step: Parsed) => typeof step.run === 'string'
    && step.run.split('\n').some((line: string) => line.includes(rejection)))
  if (!rejectsNonSuccess) {
    errors.push(`${label} required gate does not explicitly reject a non-success ${executor.job} result`)
  }

  if (errors.some((error) => error.startsWith(label))) return []
  try {
    const selectedWorkflow = { ...workflow, jobs: { [executor.job]: job } }
    const commands = collectAutomaticRunnerCommands({
      workflows: [{ path: executor.workflow, workflow: selectedWorkflow }],
      changedPaths: ['tests/e2e/ci/automatic-discovery.spec.ts'],
      packageScripts,
    })
    if (commands.length === 0) {
      errors.push(`${label} job produced no automatic pull_request runner commands`)
      return []
    }
    return collectExecutorFiles(root, commands)
  } catch (error) {
    errors.push(`${label} cannot derive its automatic collection: ${(error as Error).message}`)
    return []
  }
}

export function auditCoverage({
  root,
  manifest = JSON.parse(readFileSync(path.join(root, '.github/ci-spec-coverage.json'), 'utf8')),
  trackedPaths,
  collectExecutorFiles = (repositoryRoot: string, commands: RunnerCommand[]) => {
    return [...new Set(collectRunnerFilesMany(repositoryRoot, commands).flat())].sort()
  },
}: {
  root: string
  manifest?: CoverageManifest
  trackedPaths?: string[]
  collectExecutorFiles?: (root: string, commands: RunnerCommand[]) => string[]
}): CoverageAuditResult {
  const errors: string[] = []
  if (manifest?.version !== 3) errors.push('manifest version must be 3')
  const executors = assertArray(manifest?.automaticExecutors, 'automaticExecutors', errors)
  const exemptionReasons = assertRecord(manifest?.exemptionReasons, 'exemptionReasons', errors)
  const exemptions = assertRecord(manifest?.exemptions, 'exemptions', errors)
  const discovered = discoverSpecFiles({ root, ...(trackedPaths ? { trackedPaths } : {}) })
  const registrations = new Map<string, string>()
  const groupCounts: CoverageAuditResult['groupCounts'] = []

  function validSpecPath(spec: unknown, label: string): spec is string {
    if (typeof spec !== 'string'
      || path.posix.isAbsolute(spec)
      || path.posix.normalize(spec) !== spec
      || spec.includes('\\')
      || !TEST_ROOTS.some((testRoot) => spec.startsWith(`${testRoot}/`))) {
      errors.push(`${label} contains invalid repo-relative spec path ${JSON.stringify(spec)}`)
      return false
    }
    return true
  }

  function registerSpec(spec: string, label: string): void {
    if (!validSpecPath(spec, label)) return
    const previous = registrations.get(spec)
    if (previous) errors.push(`${spec} is registered twice: ${previous} and ${label}`)
    else registrations.set(spec, label)
  }

  function registerExecutor(group: Parsed): void {
    const disposition = 'automatic executor'
    const label = `${disposition} ${group.id ?? '(missing id)'}`
    if (typeof group.id !== 'string' || group.id.trim() === '') errors.push(`${label} requires a non-empty id`)
    if (Object.hasOwn(group, 'specs')) errors.push(`${label} must not contain a hand-maintained specs list`)
    const specs = validateWorkflowExecutor(root, group, errors, collectExecutorFiles)
    for (const spec of specs) registerSpec(spec, label)
    groupCounts.push({ id: group.id, disposition, count: specs.length })
  }

  for (const executor of executors) {
    registerExecutor(executor)
  }

  const exemptionCounts = new Map<string, number>()
  for (const [reasonId, reason] of Object.entries(exemptionReasons)) {
    if (reasonId.trim() === '') errors.push('exemptionReasons contains an empty reason id')
    if (typeof reason !== 'string' || reason.trim().length < 40) {
      errors.push(`exemption reason ${JSON.stringify(reasonId)} requires a concrete explanation of at least 40 characters`)
    }
    exemptionCounts.set(reasonId, 0)
  }
  for (const [spec, reasonId] of Object.entries(exemptions)) {
    const label = `exemption ${spec}`
    // @@@no-new-e2e (#6270) — tests/e2e/ 只收 PR CI 自动执行的 spec。豁免一条 e2e spec = 又造一条没人再跑的死用例,
    // 正是 #6270 删掉的那 370 多条的来路 ⇒ e2e 不接受豁免,只有 tests/integration 可以。
    if (spec.startsWith('tests/e2e/')) {
      errors.push(`${label}: ${NO_NEW_E2E}`)
      registerSpec(spec, label)
      continue
    }
    if (typeof reasonId !== 'string' || !Object.hasOwn(exemptionReasons, reasonId)) {
      errors.push(`${label} requires a declared reason id; received ${JSON.stringify(reasonId)}`)
      registerSpec(spec, label)
      continue
    }
    registerSpec(spec, `exemption ${reasonId}`)
    exemptionCounts.set(reasonId, (exemptionCounts.get(reasonId) ?? 0) + 1)
  }
  for (const [reasonId, reason] of Object.entries(exemptionReasons)) {
    const count = exemptionCounts.get(reasonId) ?? 0
    if (count === 0) errors.push(`exemption reason ${reasonId} is unused`)
    groupCounts.push({ id: reasonId, disposition: 'exemption', count, reason: reason as string })
  }

  const discoveredSet = new Set(discovered)
  for (const spec of discovered) {
    if (!registrations.has(spec) && spec.startsWith('tests/e2e/')) {
      errors.push(`e2e spec not run by any automatic PR executor: ${spec}; ${NO_NEW_E2E}`)
      continue
    }
    if (!registrations.has(spec)) {
      errors.push(
        `unclassified test declaration: ${spec}; add exactly one line to `
        + `.github/ci-spec-coverage.json exemptions using an existing exemptionReasons id `
        + `(not a job name), without reordering the manifest`,
      )
    }
  }
  for (const [spec, registration] of registrations) {
    if (!discoveredSet.has(spec)) errors.push(`stale ${registration}: ${spec} is not a discovered test declaration`)
  }

  return { discovered, errors, groupCounts }
}

function reportChangedSpecExecution(result: ChangedSpecExecutionResult, summaryPath = process.env.GITHUB_STEP_SUMMARY): void {
  const lines = ['## PR spec execution coverage', '']
  if (result.candidates.length === 0) {
    lines.push('No added or modified `tests/e2e/**/*.spec.ts` or `tests/integration/**` files.')
  } else if (result.gaps.length === 0) {
    lines.push(`All ${result.candidates.length} changed spec/integration file(s) are collected by an automatic PR job.`)
  } else {
    lines.push(`WARNING: ${result.gaps.length} of ${result.candidates.length} changed spec/integration file(s) are not collected by any automatic PR job:`, '')
    for (const file of result.gaps) {
      lines.push(`- \`${file}\``)
      console.log(`::warning file=${file},title=No automatic CI executor::This changed spec/integration file is not collected by any job triggered for this pull request.`)
    }
    lines.push('', 'This is informational for now; the detector remains exit 0 for execution gaps.')
  }
  const summary = `${lines.join('\n')}\n`
  if (summaryPath) appendFileSync(summaryPath, summary)
  console.log(summary.trimEnd())
}

function runCli(): void {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'base-ref': { type: 'string' },
      'event-action': { type: 'string' },
    },
    strict: true,
  })
  if ((values.base === undefined) !== (values.head === undefined)) {
    throw new Error('--base and --head must be supplied together')
  }
  const root = process.cwd()
  const result = auditCoverage({ root })
  console.log(`CI spec coverage: ${result.discovered.length} test declaration files discovered`)
  for (const group of result.groupCounts) {
    console.log(`  ${group.disposition}: ${group.id} (${group.count})${group.reason ? ` - ${group.reason}` : ''}`)
  }
  const automaticCount = result.groupCounts
    .filter((group) => group.disposition === 'automatic executor')
    .reduce((total, group) => total + group.count, 0)
  const exemptionCount = result.groupCounts
    .filter((group) => group.disposition === 'exemption')
    .reduce((total, group) => total + group.count, 0)
  console.log(`CI spec coverage totals: automatic=${automaticCount} exemptions=${exemptionCount}`)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`::error::${error}`)
    process.exitCode = 1
  } else {
    console.log('CI spec coverage: every discovered file is automatically executed or explicitly exempted')
  }

  if (values.base !== undefined) {
    const changedResult = auditChangedSpecExecution({
      root,
      base: values.base,
      head: values.head,
      baseRef: values['base-ref'] ?? process.env.GITHUB_BASE_REF ?? 'dev',
      eventAction: values['event-action'] ?? 'synchronize',
    })
    reportChangedSpecExecution(changedResult)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv[2] === '--internal-collect-one') internalCollectOne()
    else if (process.argv[2] === '--internal-collect-many') await internalCollectMany(process.argv[3])
    else runCli()
  } catch (error) {
    console.error(`::error::${(error as Error).message}`)
    process.exitCode = 1
  }
}
