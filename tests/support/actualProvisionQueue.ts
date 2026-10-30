import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as ts from 'typescript'

// Execute the existing serializer rather than reproducing its scheduling in the guard.
const text = readFileSync('apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts', 'utf8')
const ast = ts.createSourceFile('provision.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const variables = new Set(['provisionLogger', 'provisionQueue', 'provisionRunning', 'PROVISION_RUN_TIMEOUT_MS', 'PROVISION_STILL_RUNNING_INTERVAL_MS'])
const functions = new Set(['pumpProvisionQueue', 'serialize', 'withSessionpageProvisionLock'])
const statements = ast.statements.filter((node) =>
  ts.isVariableStatement(node) ? node.declarationList.declarations.some((declaration) => variables.has(declaration.name.getText(ast)))
    : ts.isFunctionDeclaration(node) && node.name ? functions.has(node.name.text) : false)
if (statements.length !== variables.size + functions.size) throw new Error('Provision serializer source is incomplete')
const source = statements.map((node) => node.getText(ast)).join('\n')
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const exports: Record<string, unknown> = {}
new Function('createLogger', 'exports', js)(() => ({ debug() {}, warn() {}, error() {} }), exports)
export const provisionQueueSourceHash = createHash('sha256').update(source).digest('hex')
export const actualProvisionLock = exports.withSessionpageProvisionLock as <T>(label: string, run: () => Promise<T>) => Promise<T>
