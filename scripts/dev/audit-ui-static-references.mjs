#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const DEFAULT_ROOTS = [
  'apps/desktop/src/components/chat',
  'apps/desktop/src/pages/explore',
  'apps/desktop/src/session/renderer/lib/ui',
  'packages/session-chat-ui/src',
  'packages/session-ui/src'
]
const POSITIVE_CONTROL = 'apps/desktop/src/session/renderer/lib/ui/markdown-renderer.tsx'

function usage() {
  return [
    'Usage: node scripts/dev/audit-ui-static-references.mjs --mode <full|no-stories|no-tests> [--root <path> ...]',
    '',
    'Prints JSON with direct static import counts. The known-live MarkdownRenderer module is always',
    'measured first as a positive control; a zero count invalidates the run and exits non-zero.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = { mode: null, roots: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (flag !== '--mode' && flag !== '--root') throw new Error(`unknown option: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--mode') options.mode = value
    else options.roots.push(value)
    index += 1
  }
  if (!['full', 'no-stories', 'no-tests'].includes(options.mode)) {
    throw new Error('--mode must be full, no-stories, or no-tests')
  }
  if (options.roots.length === 0) options.roots = DEFAULT_ROOTS
  return options
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

function normalize(file) {
  return path.resolve(file).split(path.sep).join('/')
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function trackedSourceFiles(root) {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8'
  })
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .map((file) => normalize(path.join(root, file)))
    .sort()
}

function scriptKind(file) {
  const extension = path.extname(file)
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function moduleSpecifiers(sourceFile) {
  const specifiers = []
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function isStory(file) {
  return /(?:^|\/)stories(?:\/|$)|\.stories?\.(?:[cm]?[jt]sx?|mdx)$/.test(file)
}

function isTest(file) {
  return /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function includeImporter(mode, file) {
  if (mode === 'no-stories' && isStory(file)) return false
  if (mode === 'no-tests' && isTest(file)) return false
  return true
}

function loadCompilerOptions(root) {
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, ' '))
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
}

function exportTarget(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  for (const key of ['types', 'import', 'default']) {
    const target = exportTarget(value[key])
    if (target) return target
  }
  return null
}

function workspaceExports(root, sourceSet) {
  const exportsBySpecifier = new Map()
  for (const workspaceRoot of ['apps', 'packages']) {
    const workspaceDirectory = path.join(root, workspaceRoot)
    for (const entry of readdirSync(workspaceDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageFile = path.join(workspaceDirectory, entry.name, 'package.json')
      let manifest
      try {
        manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      if (!manifest.name || !manifest.exports || typeof manifest.exports !== 'object') continue
      const packageDirectory = path.dirname(packageFile)
      for (const [subpath, value] of Object.entries(manifest.exports)) {
        const target = exportTarget(value)
        if (!target || target.includes('*')) continue
        const targetFile = normalize(path.resolve(packageDirectory, target))
        if (!sourceSet.has(targetFile)) continue
        const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`
        exportsBySpecifier.set(specifier, targetFile)
      }
    }
  }
  return exportsBySpecifier
}

function packageScriptEntries(root, sourceSet) {
  const entries = new Map()
  for (const packageFile of [
    'package.json',
    ...['apps', 'packages'].flatMap((workspaceRoot) => {
      const workspaceDirectory = path.join(root, workspaceRoot)
      return readdirSync(workspaceDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspaceRoot, entry.name, 'package.json'))
    })
  ]) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(path.join(root, packageFile), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const packageDirectory = path.dirname(path.join(root, packageFile))
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
      if (typeof command !== 'string') continue
      for (const rawToken of command.match(/[^\s;&|]+/g) ?? []) {
        const token = rawToken.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')
        const target = normalize(path.resolve(packageDirectory, token))
        if (!sourceSet.has(target)) continue
        const uses = entries.get(target) ?? []
        uses.push({ packageJson: packageFile, script: scriptName })
        entries.set(target, uses)
      }
    }
  }
  return entries
}

function zeroReferenceClassification(file, relativeFile, scriptEntries) {
  if (relativeFile.endsWith('.d.ts')) {
    return { category: 'ambient', reason: 'TypeScript ambient declaration' }
  }
  if (/\.bench\.[cm]?[jt]sx?$/.test(relativeFile)) {
    return { category: 'benchmark', reason: 'benchmark runner entry matched by file convention' }
  }
  if (relativeFile.includes('/__generated__/')) {
    return { category: 'generated', reason: 'generated artifact under __generated__/' }
  }
  const scripts = scriptEntries.get(file)
  if (scripts?.length) {
    return {
      category: 'package-script-entry',
      reason: scripts.map((entry) => `${entry.packageJson}#${entry.script}`).join(', ')
    }
  }
  if (readFileSync(file, 'utf8').startsWith('#!')) {
    return { category: 'executable-entry', reason: 'source starts with a shebang' }
  }
  return { category: 'candidate', reason: 'no static importer or recognized entry convention' }
}

function resolveModule(specifier, importer, compilerOptions, host, sourceSet, workspaceExportMap) {
  const workspaceTarget = workspaceExportMap.get(specifier)
  if (workspaceTarget) return workspaceTarget
  const resolved = ts.resolveModuleName(specifier, importer, compilerOptions, host).resolvedModule
  if (resolved) {
    let file = normalize(resolved.resolvedFileName)
    try {
      file = normalize(realpathSync(file))
    } catch {
      // TypeScript can resolve virtual declaration targets; they are outside this source graph.
    }
    if (sourceSet.has(file)) return file
  }

  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(importer), specifier)
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => path.join(base, `index${extension}`))
  ]
  for (const candidate of candidates) {
    const normalized = normalize(candidate)
    if (sourceSet.has(normalized)) return normalized
  }
  return null
}

function buildGraph(root, mode) {
  const files = trackedSourceFiles(root)
  const sourceSet = new Set(files)
  const workspaceExportMap = workspaceExports(root, sourceSet)
  const scriptEntries = packageScriptEntries(root, sourceSet)
  const compilerOptions = loadCompilerOptions(root)
  const host = ts.createCompilerHost(compilerOptions, true)
  const incoming = new Map(files.map((file) => [file, new Set()]))
  const unresolvedInternal = []

  for (const importer of files) {
    const importerPath = relative(root, importer)
    if (!includeImporter(mode, importerPath)) continue
    const source = readFileSync(importer, 'utf8')
    const sourceFile = ts.createSourceFile(
      importer,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(importer)
    )
    for (const specifier of new Set(moduleSpecifiers(sourceFile))) {
      const target = resolveModule(
        specifier,
        importer,
        compilerOptions,
        host,
        sourceSet,
        workspaceExportMap
      )
      if (target) incoming.get(target)?.add(importer)
      else if (
        specifier.startsWith('.') ||
        specifier.startsWith('@gugu/') ||
        specifier.startsWith('@renderer/') ||
        specifier.startsWith('@session-')
      ) {
        unresolvedInternal.push({ importer: importerPath, specifier })
      }
    }
  }
  return { files, incoming, scriptEntries, unresolvedInternal }
}

function run(options) {
  const root = repoRoot()
  const graph = buildGraph(root, options.mode)
  const controlFile = normalize(path.join(root, POSITIVE_CONTROL))
  const controlImporters = [...(graph.incoming.get(controlFile) ?? [])]
    .map((file) => relative(root, file))
    .sort()
  if (controlImporters.length === 0) {
    throw new Error(`positive control failed: ${POSITIVE_CONTROL} has 0 resolved static importers`)
  }

  const roots = options.roots.map((candidateRoot) => `${candidateRoot.replace(/\/$/, '')}/`)
  const modules = graph.files
    .map((file) => ({ file, relativeFile: relative(root, file) }))
    .filter(({ relativeFile }) =>
      roots.some((candidateRoot) => relativeFile.startsWith(candidateRoot))
    )
    .filter(({ relativeFile }) => !isStory(relativeFile) && !isTest(relativeFile))
    .map(({ file, relativeFile }) => ({
      path: relativeFile,
      staticReferences: graph.incoming.get(file)?.size ?? 0
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const zeroReferenceModules = modules
    .filter((entry) => entry.staticReferences === 0)
    .map((entry) => {
      const file = normalize(path.join(root, entry.path))
      return { ...entry, ...zeroReferenceClassification(file, entry.path, graph.scriptEntries) }
    })
  const candidates = zeroReferenceModules.filter((entry) => entry.category === 'candidate')
  const excluded = zeroReferenceModules.filter((entry) => entry.category !== 'candidate')

  return {
    mode: options.mode,
    scannedSources: graph.files.length,
    positiveControl: {
      path: POSITIVE_CONTROL,
      staticReferences: controlImporters.length,
      importers: controlImporters
    },
    modules,
    zeroReferenceModules: candidates,
    excludedZeroReferenceModules: excluded,
    zeroReferenceSummary: Object.fromEntries(
      [...new Set(zeroReferenceModules.map((entry) => entry.category))]
        .sort()
        .map((category) => [
          category,
          zeroReferenceModules.filter((entry) => entry.category === category).length
        ])
    ),
    unresolvedInternalImports: graph.unresolvedInternal
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
  } else {
    console.log(JSON.stringify(run(options), null, 2))
  }
} catch (error) {
  console.error(`ui static-reference audit failed: ${error.message}`)
  process.exitCode = 1
}
