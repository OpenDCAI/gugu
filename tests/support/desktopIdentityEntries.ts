import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { SESSION_SHELL_CHANNELS } from '../../apps/desktop/src/session/shared/lib/ipc/shell-port'

/** Execute the actual desktop registrations without starting Electron. Only transport/host boundaries are injected. */
export function desktopIdentityEntries(bindings: Record<string, unknown>) {
  const source = readFileSync('apps/desktop/electron/main.ts', 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const callbacks = new Map<string, string>()
  const properties = new Map<string, string>()
  let localPeers = ''
  let peersBranch = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'localSessionPeers') localPeers = node.getText(ast)
    if (ts.isCallExpression(node) && ['handleShellChannel', 'ipcMain.handle'].includes(node.expression.getText(ast))) {
      const key = node.arguments[0]
      const callback = node.arguments[1]
      if (key && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const channel = ts.isStringLiteral(key) ? key.text
          : Object.entries(SESSION_SHELL_CHANNELS).find(([name]) => key.getText(ast) === `SESSION_SHELL_CHANNELS.${name}`)?.[1]
        if (channel && [SESSION_SHELL_CHANNELS.agentNames, SESSION_SHELL_CHANNELS.sessionPeers,
          SESSION_SHELL_CHANNELS.agentCard, SESSION_SHELL_CHANNELS.shareAgent,
          'owned-agent:rename-local-footprint'].includes(channel)) callbacks.set(channel, callback.getText(ast))
      }
    }
    if (ts.isIfStatement(node) && node.expression.getText(ast) === "record.action === 'peers'") peersBranch = node.getText(ast)
    if (ts.isPropertyAssignment(node) && ['peers', 'resolveLocalGuguNumbers'].includes(node.name.getText(ast))) {
      properties.set(node.name.getText(ast), node.initializer.getText(ast))
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!localPeers || !peersBranch || !properties.has('peers')) throw new Error('Desktop identity entry source missing')
  const transpile = (text: string) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const evaluate = (text: string, result: string, scope: Record<string, unknown>) =>
    new Function(...Object.keys(scope), `${transpile(text)}; return ${result}`)(...Object.values(scope)) as (...args: unknown[]) => unknown
  const scope = { ...bindings, localSessionPeers: evaluate(localPeers, 'localSessionPeers', bindings) }
  const callback = (text: string) => evaluate(`const callback = ${text}`, 'callback', scope)
  const handlers = new Map([...callbacks].map(([channel, text]) => [channel, callback(text)]))
  return {
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Desktop identity handler missing: ${channel}`)
      return handler({}, ...args)
    },
    mcpPeers: callback(`async () => { ${peersBranch} }`),
    remotePeers: callback(properties.get('peers')!),
    localNumbers: callback(properties.get('resolveLocalGuguNumbers')!),
  }
}
