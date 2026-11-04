import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')
type Node = import('typescript').Node

export type HardcodedCjkCategory = 'user-visible' | 'developer' | 'false-positive'

export interface HardcodedCjkRow {
  file: string
  line: number
  column: number
  kind: string
  text: string
  category: HardcodedCjkCategory
  reason: string
}

export interface HardcodedCjkAudit {
  total: number
  categories: Record<HardcodedCjkCategory, number>
  fileDistribution: Record<HardcodedCjkCategory, Record<string, number>>
  rows: HardcodedCjkRow[]
}

const CJK = /[\u3400-\u9fff]/u
const CJK_GLOBAL = /[\u3400-\u9fff]/gu
const SOURCE_ROOT = 'apps/desktop/src'

function sourceFilesBelow(root: string, directory: string = root): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const absolute = path.join(directory, entry.name)
      return entry.isDirectory() ? sourceFilesBelow(root, absolute) : [absolute]
    })
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.includes(`${path.sep}session${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}i18n${path.sep}locales${path.sep}`))
    .filter((file) => !/\.(?:test|spec)\.[^.]+$/.test(file))
    .sort()
}

function isTextNode(node: Node): node is import('typescript').LiteralLikeNode | import('typescript').JsxText {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node)
    || ts.isTemplateTail(node)
    || ts.isJsxText(node)
    || ts.isRegularExpressionLiteral(node)
}

function textValue(node: import('typescript').LiteralLikeNode | import('typescript').JsxText, sourceFile: import('typescript').SourceFile): string {
  return ts.isJsxText(node) ? node.getText(sourceFile) : node.text ?? node.getText(sourceFile)
}

function enclosingCall(node: Node): import('typescript').CallExpression | import('typescript').NewExpression | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) return current
    if (ts.isStatement(current) || ts.isJsxElement(current) || ts.isJsxAttribute(current)) return null
  }
  return null
}

function stylesheetPayload(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current) && current.openingElement.tagName.getText() === 'style') return true
    if (ts.isVariableDeclaration(current) && /(?:CSS|STYLES?)$/i.test(current.name.getText())) return true
    if (ts.isTaggedTemplateExpression(current) && /(?:css|style|styled)$/i.test(current.tag.getText())) return true
    if (ts.isStatement(current)) return false
  }
  return false
}

function diagnosticLoggerCall(call: Node): boolean {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  const receiver = call.expression.expression.getText()
  const method = call.expression.name.text
  return /^(?:debug|info|log|warn|error)$/.test(method)
    && (receiver === 'console' || /(?:log|logger)$/i.test(receiver))
}

function isStructuralPropertyName(node: Node): boolean {
  const parent = node.parent
  return (ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isMethodSignature(parent))
    && parent.name === node
}

function classify(node: Node, value: string): { category: HardcodedCjkCategory; reason: string } {
  if (ts.isRegularExpressionLiteral(node)) return { category: 'false-positive', reason: 'regular-expression' }
  if (isStructuralPropertyName(node) || ts.isLiteralTypeNode(node.parent)) {
    return { category: 'false-positive', reason: 'structural-literal' }
  }
  if (stylesheetPayload(node) && !CJK.test(value.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    return { category: 'false-positive', reason: 'stylesheet-comment' }
  }
  const cjkOnly = [...value.matchAll(CJK_GLOBAL)].map((match) => match[0]).join('')
  if (cjkOnly && /^咕+$/.test(cjkOnly)) return { category: 'false-positive', reason: 'brand-only' }

  const call = enclosingCall(node)
  if (call) {
    if (diagnosticLoggerCall(call)) return { category: 'developer', reason: 'diagnostic-call' }
  }
  return { category: 'user-visible', reason: 'product-value' }
}

export function auditHardcodedCjk(root: string = process.cwd()): HardcodedCjkAudit {
  const sourceRoot = path.resolve(root, SOURCE_ROOT)
  const rows: HardcodedCjkRow[] = []
  for (const absoluteFile of sourceFilesBelow(root, sourceRoot)) {
    const file = path.relative(root, absoluteFile)
    const sourceText = readFileSync(absoluteFile, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: Node): void => {
      if (isTextNode(node)) {
        const value = textValue(node, sourceFile)
        if (CJK.test(value)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          rows.push({
            file,
            line: position.line + 1,
            column: position.character + 1,
            kind: ts.SyntaxKind[node.kind],
            text: value.replace(/\s+/g, ' ').trim(),
            ...classify(node, value),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  const categories = Object.fromEntries(
    ['user-visible', 'developer', 'false-positive'].map((category) => [
      category,
      rows.filter((row) => row.category === category).length,
    ]),
  )
  const fileDistribution = Object.fromEntries(
    Object.keys(categories).map((category) => {
      const counts = new Map<string, number>()
      for (const row of rows.filter((candidate) => candidate.category === category)) {
        counts.set(row.file, (counts.get(row.file) ?? 0) + 1)
      }
      return [category, Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))]
    }),
  )
  return {
    total: rows.length,
    categories: categories as Record<HardcodedCjkCategory, number>,
    fileDistribution: fileDistribution as Record<HardcodedCjkCategory, Record<string, number>>,
    rows,
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const result = auditHardcodedCjk()
  console.log(JSON.stringify(result, null, 2))
  if (result.categories['user-visible'] > 0) process.exitCode = 1
}
