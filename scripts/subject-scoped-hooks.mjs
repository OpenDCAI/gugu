// @@@3922 找出「收一个主体参数、且**返回值**」的 renderer hook —— 状态串台那一族的候选面。
//
// 用真 AST,不用正则:正则原型实测会静默吞掉函数 —— `useAgentDisplayStatus` 没有返回类型标注(`) {`),
// 非贪婪匹配一路找到下一个函数的 `): T {` 才停,把 `useAgentDisplayStatuses` 整个吃掉。
// 凡是省略返回类型的 hook 都会被错配,而一个会漏的名单比没有名单更坏(它给出「已覆盖」的假象)。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export const HOOKS_DIR = 'apps/desktop/src/hooks'

/** 主体 = 用来指认「这份读数说的是谁」的那个参数。 */
const SUBJECT = /(^|[a-z])(Id|Key)s?$|^(id|key)s?$/

function paramNames(node) {
  const out = []
  for (const p of node.parameters) {
    if (ts.isIdentifier(p.name)) out.push(p.name.text)
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) if (ts.isIdentifier(el.name)) out.push(el.name.text)
    }
    // 参数是内联对象类型时(`params: { chatId: string … }` 那种),字段名也算主体来源
    if (p.type && ts.isTypeLiteralNode(p.type)) {
      for (const m of p.type.members) if (m.name && ts.isIdentifier(m.name)) out.push(m.name.text)
    }
  }
  return out
}

function returnsAValue(node) {
  if (node.type) return node.type.kind !== ts.SyntaxKind.VoidKeyword
  // 没有标注 ⇒ 看函数体里有没有带表达式的 return(不进嵌套函数)
  let found = false
  const walk = (n) => {
    if (found) return
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      if (n !== node) return
    }
    if (ts.isReturnStatement(n) && n.expression) { found = true; return }
    ts.forEachChild(n, walk)
  }
  if (node.body) walk(node.body)
  return found
}

export function scanSubjectScopedHooks(root = '.') {
  const dir = join(root, HOOKS_DIR)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')).sort()
  const found = []
  for (const f of files) {
    const rel = `${HOOKS_DIR}/${f}`
    const src = ts.createSourceFile(f, readFileSync(join(dir, f), 'utf8'), ts.ScriptTarget.Latest, true)
    for (const stmt of src.statements) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue
      const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (!exported || !stmt.name.text.startsWith('use')) continue
      if (!paramNames(stmt).some((p) => SUBJECT.test(p))) continue
      if (!returnsAValue(stmt)) continue
      found.push(`${rel}::${stmt.name.text}`)
    }
  }
  return found.sort()
}

if (process.argv[1]?.endsWith('subject-scoped-hooks.mjs')) {
  const hits = scanSubjectScopedHooks()
  console.log(JSON.stringify(hits, null, 2))
  console.log('count =', hits.length)
}
