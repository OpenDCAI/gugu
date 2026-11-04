#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
])

function usage() {
  return [
    'Usage: node scripts/checks/check-file-url-paths.mjs [--root <path>]',
    '',
    'Rejects file URL strings and URL.pathname values used as filesystem paths.',
    'Use fileURLToPath(...) so percent-encoded non-ASCII paths are decoded correctly.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { root: '.' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (flag !== '--root') throw new Error(`unknown option: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('--root requires a value')
    options.root = value
    index += 1
  }
  return options
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

function sourceFiles(target) {
  const metadata = statSync(target)
  if (metadata.isFile()) return SCRIPT_EXTENSIONS.has(path.extname(target).toLowerCase()) ? [target] : []
  if (!metadata.isDirectory()) return []

  const files = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    const absolute = path.join(target, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(absolute)
  }
  return files.sort()
}

function scriptKind(file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression
  return current
}

function isProcessArgvOne(node) {
  const expression = unwrap(node)
  if (!ts.isElementAccessExpression(expression)) return false
  const receiver = unwrap(expression.expression)
  const argument = expression.argumentExpression && unwrap(expression.argumentExpression)
  return Boolean(
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === 'process' &&
    receiver.name.text === 'argv' &&
    argument &&
    ts.isNumericLiteral(argument) &&
    argument.text === '1'
  )
}

function isFileUrlArgvTemplate(node) {
  return ts.isTemplateExpression(node) &&
    node.head.text === 'file://' &&
    node.templateSpans.length === 1 &&
    isProcessArgvOne(node.templateSpans[0].expression) &&
    node.templateSpans[0].literal.text === ''
}

function isImportMetaUrl(node) {
  const expression = unwrap(node)
  return ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta'
}

function isImportMetaUrlPathname(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'pathname') return false
  const receiver = unwrap(node.expression)
  return ts.isNewExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === 'URL' &&
    Boolean(receiver.arguments?.some(isImportMetaUrl))
}

function scanSource(source, file, relativeFile) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`${relativeFile}: TypeScript parse error: ${message}`)
  }

  const violations = []
  function report(node, rule) {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({
      column: location.character + 1,
      file: relativeFile,
      line: location.line + 1,
      rule,
    })
  }
  function visit(node) {
    if (isFileUrlArgvTemplate(node)) report(node, 'encoded-entry-guard')
    if (isImportMetaUrlPathname(node)) report(node, 'encoded-pathname')
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

export function scan(rootDirectory, scanRoot) {
  const absoluteRoot = path.resolve(rootDirectory, scanRoot)
  const files = sourceFiles(absoluteRoot)
  if (files.length === 0) throw new Error(`scan root contains no supported source files: ${scanRoot}`)

  const violations = []
  for (const file of files) {
    const relativeFile = path.relative(rootDirectory, file).split(path.sep).join('/')
    violations.push(...scanSource(readFileSync(file, 'utf8'), file, relativeFile))
  }
  return { scanned: files.length, violations }
}

export function run(argv, output = console) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      output.log(usage())
      return 0
    }
    const result = scan(repoRoot(), options.root)
    for (const violation of result.violations) {
      output.error(
        `${violation.file}:${violation.line}:${violation.column}: unsafe file URL path handling (${violation.rule}); use fileURLToPath(...)`
      )
    }
    if (result.violations.length > 0) {
      output.error(`file URL path guard failed: ${result.violations.length} violation(s) across ${result.scanned} files`)
      return 1
    }
    output.log(`file URL path guard passed: ${result.scanned} files scanned, 0 violations`)
    return 0
  } catch (error) {
    output.error(`file URL path guard error: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2))
}
