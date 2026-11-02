import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps Electron notification support probes inside the host gate', () => {
  const root = resolve('apps/desktop/electron')
  const probes: string[] = []
  function scan(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) { scan(file); continue }
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || relative(root, file) === 'session/headless/electron-shim.ts') continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'isSupported'
          && /(?:^|\.)Notification$/.test(node.expression.expression.getText(source))) {
          probes.push(relative(root, file))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  scan(root)
  expect(probes).toEqual(['main.ts'])
})
