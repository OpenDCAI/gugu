#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const DEFAULT_ROOT = 'packages/session-chat-ui/src'
const SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const TEXT_EXTENSIONS = new Set(['.css', '.mdx'])

const RULES = [
  {
    category: 'spacing',
    pattern: /^-?(?:p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy])-(?:[^\s]+)$/
  },
  {
    category: 'radius',
    pattern:
      /^rounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full|[trblse]{1,2})(?:-(?:none|sm|md|lg|xl|2xl|3xl|full|\[[^\]]+\]))?|-(?:\[[^\]]+\]))?$/
  },
  {
    category: 'border',
    pattern: /^(?:border(?:-[^\s]+)?|divide-[xy](?:-[^\s]+)?)$/
  },
  {
    category: 'font-size',
    pattern:
      /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[(?:length:)?(?:-?\d|calc\(|clamp\(|min\(|max\(|var\()[^\]]*\])$/
  }
]

function usage() {
  return [
    'Usage: node scripts/checks/check-session-chat-ui-geometry.mjs [--root <path>]',
    '',
    `Scans JSX class/className/classList values and CSS @apply under ${DEFAULT_ROOT}/**.`,
    'Markdown fixtures and ordinary prose strings are outside the scan surface.',
    'Identifier data flow is not followed: class={name} is allowed; literals inside the class expression are checked.',
    'Measured transcript geometry must come from shared TypeScript constants instead.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT }
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

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files.sort()
}

function scriptKind(file) {
  const extension = path.extname(file)
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function utilityPart(token) {
  const afterVariant = token.slice(token.lastIndexOf(':') + 1)
  return afterVariant.replace(/^!/, '')
}

function classify(token) {
  const utility = utilityPart(token)
  return RULES.find((rule) => rule.pattern.test(utility))?.category ?? null
}

function scanLiteral(node, sourceFile, relativeFile, violations) {
  const text = node.text
  const tokenPattern = /\S+/g
  let match
  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[0]
    const category = classify(token)
    if (!category) continue
    const position = Math.min(node.getStart(sourceFile) + 1 + match.index, node.end - 1)
    const location = sourceFile.getLineAndCharacterOfPosition(position)
    violations.push({
      category,
      column: location.character + 1,
      file: relativeFile,
      line: location.line + 1,
      token
    })
  }
}

function scanScript(source, file, relativeFile) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file)
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`${relativeFile}: TypeScript parse error: ${message}`)
  }

  const violations = []
  function scanClassValue(node) {
    if (
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      scanLiteral(node, sourceFile, relativeFile, violations)
    }
    ts.forEachChild(node, scanClassValue)
  }

  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      const attributeName = node.name.getText(sourceFile)
      if (['class', 'className', 'classList'].includes(attributeName) && node.initializer) {
        scanClassValue(node.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function scanText(source, relativeFile) {
  const violations = []
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    const regions = []
    const apply = line.match(/@apply\s+([^;]+)/)
    if (apply) regions.push({ offset: apply.index + apply[0].indexOf(apply[1]), text: apply[1] })
    for (const quote of line.matchAll(/(?:class|className)\s*=\s*["']([^"']*)["']/g)) {
      regions.push({ offset: quote.index + quote[0].indexOf(quote[1]), text: quote[1] })
    }
    for (const region of regions) {
      for (const match of region.text.matchAll(/\S+/g)) {
        const category = classify(match[0])
        if (!category) continue
        violations.push({
          category,
          column: region.offset + match.index + 1,
          file: relativeFile,
          line: lineIndex + 1,
          token: match[0]
        })
      }
    }
  }
  return violations
}

export function scan(rootDirectory, scanRoot) {
  const absoluteRoot = path.resolve(rootDirectory, scanRoot)
  if (!statSync(absoluteRoot).isDirectory())
    throw new Error(`scan root is not a directory: ${scanRoot}`)

  const violations = []
  let scanned = 0
  for (const file of sourceFiles(absoluteRoot)) {
    const extension = path.extname(file)
    if (!SCRIPT_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) continue
    scanned += 1
    const source = readFileSync(file, 'utf8')
    const relativeFile = path.relative(rootDirectory, file).split(path.sep).join('/')
    violations.push(
      ...(SCRIPT_EXTENSIONS.has(extension)
        ? scanScript(source, file, relativeFile)
        : scanText(source, relativeFile))
    )
  }
  return { scanned, violations }
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
        `${violation.file}:${violation.line}:${violation.column}: forbidden Tailwind ${violation.category} utility "${violation.token}"`
      )
    }
    if (result.violations.length > 0) {
      output.error(
        `session-chat-ui geometry guard failed: ${result.violations.length} violation(s) across ${result.scanned} files`
      )
      return 1
    }
    output.log(`session-chat-ui geometry guard passed: ${result.scanned} files scanned, 0 violations`)
    return 0
  } catch (error) {
    output.error(`session-chat-ui geometry guard error: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
