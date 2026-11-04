import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { PERMANENT_REMOVAL_RPCS } from '../../packages/core/src/cloud/agentIdentityRemoval.ts'

const entry = 'packages/core/src/cloud/agentIdentityRemoval.ts'
const rpcs = new Set<string>(Object.values(PERMANENT_REMOVAL_RPCS))
// Existing explicit deletion and non-identity GC are the only roster-removal callers.
const removalCallers: Record<string, Record<string, string>> = {
  permanentlyDeleteAgentSession: {},
  permanentlyRemove: {
    'packages/core/src/cloud/devices.ts': 'removeDevice',
  },
  removeAgents: {
    'apps/desktop/electron/sessionpage/agent-local-footprint.ts': 'releaseAgentLocalFootprint',
    'apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts': 'startCloudProvision',
    'packages/core/src/cloud/deviceRuntimeHost.ts': 'dropLocalAgentByGuguUserId',
    'packages/core/src/local/agent/deviceCommandRuntime.ts': 'pruneDeadGuestRecords',
  },
}
function enclosingFunction(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) return parent.name.getText()
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText()
  }
  return undefined
}

export function removalViolations(file: string, text: string): string[] {
  if (file === entry) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const failures: string[] = []
  const bindings = new Map(Object.keys(removalCallers).map(name => [name, name]))
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) || ts.isBindingElement(node)) {
      const original = node.propertyName?.getText(source) ?? node.name.getText(source)
      if (bindings.has(original)) bindings.set(node.name.getText(source), bindings.get(original)!)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(source)
  const flag = (node: ts.Node) => failures.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
  const visit = (node: ts.Node): void => {
    // Catch indirect RPC operands at their declaration as well as direct calls.
    const literal = ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail
    if (literal && !ts.isLiteralTypeNode(node.parent) && (rpcs.has((node as ts.LiteralLikeNode).text) || /\bdelete\s+from\s+(?:[\w"]+\.)?["]?sessions\b/i.test((node as ts.LiteralLikeNode).text))) flag(node)
    if (ts.isIdentifier(node) && node.text === 'deleteSession') flag(node)
    if (ts.isIdentifier(node) && bindings.has(node.text) && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent) && !ts.isBindingElement(node.parent) && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
      const operation = bindings.get(node.text)!
      if (!removalCallers[operation][file] || removalCallers[operation][file] !== enclosingFunction(node)) flag(node)
    }
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
