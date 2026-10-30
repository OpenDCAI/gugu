import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Only the browser platform boundary may reach the browser clipboard transport. */
function directWrites(source: string) {
  const file = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const aliases = new Map<string, string>()
  const found = new Set<number>()
  const path = (node: ts.Node): string => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return path(node.expression)
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text
    if (ts.isPropertyAccessExpression(node)) return `${path(node.expression)}.${node.name.text}`
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) return `${path(node.expression)}.${node.argumentExpression.text}`
    return ''
  }
  const forbidden = (value: string) => /(^|\.)navigator\.clipboard\.writeText$/.test(value)
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const base = path(node.initializer)
      if (ts.isIdentifier(node.name) && base) aliases.set(node.name.text, base)
      if (ts.isObjectBindingPattern(node.name)) for (const part of node.name.elements) {
        const key = part.propertyName ?? part.name
        if (!ts.isIdentifier(part.name) || (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key))) continue
        const value = `${base}.${key.text}`
        aliases.set(part.name.text, value)
        if (forbidden(value)) found.add(file.getLineAndCharacterOfPosition(part.getStart(file)).line + 1)
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && forbidden(path(node))) {
      found.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...found]
}

describe('browser clipboard transport boundary', () => {
  it.each([
    'navigator.clipboard.writeText(text)',
    'navigator.clipboard?.writeText(text)',
    'window.navigator.clipboard.writeText(text)',
    'navigator["clipboard"]["writeText"](text)',
    '(navigator as Navigator).clipboard.writeText(text)',
    'const clipboard = navigator.clipboard; clipboard.writeText(text)',
    'const { clipboard: clip } = navigator; clip.writeText(text)',
    'const { writeText: copy } = navigator.clipboard; copy(text)',
    'if (navigator.clipboard?.writeText) copy()',
  ])('rejects a bypass: %s', source => expect(directWrites(source)).not.toEqual([]))

  it.each(['platform.writeClipboardText(text)', 'host.clipboard.writeText(text)', 'Clipboard.write({ string: text })'])('permits a host boundary: %s', source => expect(directWrites(source)).toEqual([]))

  it('keeps every production caller behind the single browser platform exit', () => {
    const paths = execFileSync('git', ['ls-files', '--', 'apps/desktop/src', 'packages'], { encoding: 'utf8' }).trim().split('\n')
    const failures = paths.filter(path => /\.[cm]?[jt]sx?$/.test(path)
      && !/(?:^|\/)(?:tests|stories)\//.test(path) && !/\.(?:test|spec)\./.test(path)
      && path !== 'apps/desktop/src/platform/browserClipboard.ts')
      .flatMap(path => directWrites(readFileSync(path, 'utf8')).map(line => `${path}:${line}`))
    expect(failures, 'Copy through platform.writeClipboardText; shared packages require the host capability.').toEqual([])
  })
})
