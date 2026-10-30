import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { PERMANENT_REMOVAL_RPCS } from '../packages/core/src/cloud/agentIdentityRemoval.ts'

const entry = 'packages/core/src/cloud/agentIdentityRemoval.ts'
const rpcs = new Set(Object.values(PERMANENT_REMOVAL_RPCS))

export function removalViolations(file, text) {
  if (file === entry) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const failures = []
  const flag = node => failures.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
  const visit = node => {
    // Catch indirect RPC operands at their declaration as well as direct calls.
    const literal = ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail
    if (literal && !ts.isLiteralTypeNode(node.parent) && (rpcs.has(node.text) || /\bdelete\s+from\s+(?:[\w"]+\.)?["]?sessions\b/i.test(node.text))) flag(node)
    if (ts.isIdentifier(node) && node.text === 'deleteSession') flag(node)
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'delete' && /(?:^|\.)sessions$/.test(node.arguments[0]?.getText(source) ?? '')) flag(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps', 'packages'], { encoding: 'utf8' }).split('\0')
  const failures = [...new Set(files.filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/(?:^|\/)(?:tests?|__tests__|__fixtures__)\/|\.test\./.test(file))
    .flatMap(file => removalViolations(file, readFileSync(file, 'utf8'))))]
  for (const failure of failures) console.error(`${failure}: permanent removal must use ${entry}; task cleanup must archive`)
  process.exitCode = failures.length ? 1 : 0
}
