#!/usr/bin/env node
// 数「手写 <button> 里有多少还没有四态反馈」。
//
// 为什么不是一句 grep:类名到达 <button> 的路径有五种,行级 grep 只看得见第一种。
// 我按行数报过一次「406 个待迁移」,那个数没有分母 —— 它把 177 个由父组件供样式的
// Base UI render-prop 也算成了债务。这个脚本存在的理由就是让这个数可复算、且带阳性对照。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOKEN_CLASS = /gg-(pressable|ghost|row|fill|seg|mi)/
const HOVER = /hover:/
const PRESS = /active:|data-\[pressed\]/

// 括号感知地切出 <button ...> 开标签。`onClick={() => x}` 里的 '>' 不是标签结束 ——
// 用 /<button[^>]*>/ 会在那里截断,className 若写在 onClick 之后就整个读不到。
// 注释里的 '<button' 不是按钮。合成夹具第一次跑就抓到了这个:它数出 12,而夹具只有 10 个 ——
// 多出来的两个来自本文件头和夹具里两句**提到** <button 的注释。行级 grep 同样有这个病。
export function stripComments(source) {
  return source.replace(/\/\*[^]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export function buttonTags(rawSource) {
  const source = stripComments(rawSource)
  const tags = []
  for (let i = source.indexOf('<button'); i !== -1; i = source.indexOf('<button', i + 1)) {
    let depth = 0
    let j = i
    for (; j < source.length; j++) {
      const c = source[j]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    tags.push(source.slice(i, j + 1))
  }
  return tags
}

// 样式常量常常住在隔壁的 *Styles.ts 里。只看当前文件时,AgentSettingsModal 的 13 个按钮
// 会全部被判成「无反馈」——而 asClass.close 明明带着 hover。跨文件是第六种、也是最后一种形态。
function importedSources(source, fromFile) {
  const out = []
  if (!fromFile) return out
  for (const [, spec] of source.matchAll(/import\s+[^;]*?from\s+['"](\.[^'"]*)['"]/g)) {
    const base = path.resolve(path.dirname(fromFile), spec)
    for (const cand of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) { out.push(readFileSync(cand, 'utf8')); break }
    }
  }
  return out
}

function objectMemberValue(source, objectName, key) {
  const start = source.search(new RegExp(`(?:const|let)\\s+${objectName}\\s*=\\s*\\{`))
  if (start < 0) return ''
  let i = source.indexOf('{', start)
  let depth = 0
  let end = i
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}' && --depth === 0) break
  }
  const kv = source.slice(i, end).match(new RegExp(`\\b${key}\\s*:\\s*((?:\\s*['"\`][^'"\`]*['"\`])+)`))
  return kv ? kv[1].replace(/['"`]/g, ' ') : ''
}

// 把 className 表达式解析成实际参与的类名。标识符与对象成员都要回查同文件的定义 ——
// 组件是「按引用」采用 token 类的,标签里根本不出现 gg-ghost 这几个字。
// 一个表达式里真正承载类名的东西:调用 `f(...)` 的 f、成员 `a.b`、以及裸标识符。
// `contactRowClass(selected)` 里的 selected 是布尔入参,不是类名来源 —— 不能把它算成解析失败。
function classSources(expr) {
  const out = new Set()
  for (const [, f] of expr.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) if (f !== 'cn' && f !== 'cx') out.add(f + '()')
  for (const [m] of expr.matchAll(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/g)) out.add(m)
  const bare = expr.trim()
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) out.add(bare)
  for (const [, a] of expr.matchAll(/(?:cn|cx)\(([^)]*)\)/g))
    for (const piece of a.split(',')) { const t = piece.trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t) }
  return [...out]
}

function lookupString(name, scopes) {
  for (const scope of scopes) {
    const def = scope.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*(?:cn\\(|cx\\()?\\s*['"\`]([^'"\`]*)['"\`]`))
    if (def) return def[1]
  }
  return null
}

// 工厂:const f = (...) => BODY  或  function f(...) { ... }。取其函数体,再按同一套规则解析。
function lookupFactoryBody(name, scopes) {
  for (const scope of scopes) {
    const arrow = scope.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*(?::[^=]*)?=>\\s*([^]*?)(?=\\n\\n|\\nconst |\\nlet |\\nfunction |\\nexport )`))
    if (arrow) return arrow[1]
    const fn = scope.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{([^]*?)\\n\\}`))
    if (fn) return fn[1]
  }
  return null
}

// 返回 { classes, unresolved }。unresolved 必须被调用方看见 ——
// 一个回查不到的类名来源若静默贡献一个「没有 bg-」的串,它就和「真的没有背景」同形。
export function resolveDetail(tag, source, fromFile, depth = 0) {
  const literal = tag.match(/className="([^"]*)"/)
  if (literal) return { classes: literal[1], unresolved: [] }
  const at = tag.indexOf('className={')
  if (at < 0) return { classes: null, unresolved: [] }
  let k = at + 'className={'.length
  const from = k
  let d = 1
  for (; k < tag.length && d > 0; k++) { if (tag[k] === '{') d++; else if (tag[k] === '}') d-- }
  return resolveExpr(tag.slice(from, k - 1), source, fromFile, depth)
}

function resolveExpr(expr, source, fromFile, depth) {
  const scopes = [source, ...importedSources(source, fromFile)]
  let out = expr
  const unresolved = []
  for (const src of classSources(expr)) {
    if (src.endsWith('()')) {
      const name = src.slice(0, -2)
      const body = lookupFactoryBody(name, scopes)
      if (body && depth < 3) {
        const inner = resolveExpr(body, source, fromFile, depth + 1)
        out += ' ' + inner.classes
        unresolved.push(...inner.unresolved)
      } else unresolved.push(src)
      continue
    }
    if (src.includes('.')) {
      const [obj, key] = src.split('.')
      let hit = null
      for (const scope of scopes) { const v = objectMemberValue(scope, obj, key); if (v) { hit = v; break } }
      if (hit) out += ' ' + hit; else unresolved.push(src)
      continue
    }
    const lit = lookupString(src, scopes)
    if (lit !== null) out += ' ' + lit; else unresolved.push(src)
  }
  return { classes: out, unresolved }
}

export function resolveClasses(tag, source, fromFile) {
  return resolveDetail(tag, source, fromFile).classes
}

// 类名也可能定义在 .css 文件里(gg-winctl 这类),它们的 hover/active
// 根本不出现在 tsx 的类名串里。只看 Tailwind 工具类,会把「在 CSS 里有 :hover」的按钮
// 一律记成「无反馈」—— 又一次:同一个读数,两个来源。
export function buildCssIndex(root) {
  const index = new Map()
  const note = (name, kind) => {
    const rec = index.get(name) ?? { hover: false, active: false }
    rec[kind] = true
    index.set(name, rec)
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue }
      // CSS 有两个住处:.css 文件,和 tsx 里的内联 <style>{`…`}</style>。
      // LoginPage 的 .gugu-primary-btn:hover 就住在后者 —— 只扫 .css 会把它记成「无反馈」。
      let css = ''
      if (full.endsWith('.css')) css = readFileSync(full, 'utf8')
      else if (full.endsWith('.tsx')) {
        for (const [, block] of readFileSync(full, 'utf8').matchAll(/<style[^>]*>\{`([^]*?)`\}<\/style>/g)) css += block + '\n'
      }
      if (!css) continue
      for (const [, selector] of css.matchAll(/([^{}]+)\{/g)) {
        const hover = selector.includes(':hover')
        const active = selector.includes(':active') || selector.includes('[data-pressed')
        if (!hover && !active) continue
        for (const [, cls] of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
          if (hover) note(cls, 'hover')
          if (active) note(cls, 'active')
        }
      }
    }
  }
  walk(root)
  return index
}

export function classify(tag, source, fromFile, cssIndex) {
  const { classes: cls, unresolved } = resolveDetail(tag, source, fromFile)
  if (cls === null) return 'no-class'
  if (TOKEN_CLASS.test(cls)) return 'adopted'
  let hover = HOVER.test(cls)
  let press = PRESS.test(cls)
  if (cssIndex) {
    for (const [, name] of cls.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
      const rec = cssIndex.get(name)
      if (!rec) continue
      hover = hover || rec.hover
      press = press || rec.active
    }
  }
  if (hover && press) return 'full-handrolled'
  if (hover) return 'hover-only'
  // 有没解析开的类名来源,且没读到任何反馈 —— 这条读数不成立,不能记成「无反馈」。
  // 静默把它算进债务,就是让「真的没有反馈」和「我没看懂」在同一个桶里。
  if (unresolved.length > 0) return 'unresolved'
  return 'no-feedback'
}

export function scan(root) {
  const counts = { total: 0, adopted: 0, 'full-handrolled': 0, 'hover-only': 0, 'no-feedback': 0, 'no-class': 0, unresolved: 0 }
  const perFile = new Map()
  const cssIndex = buildCssIndex(root)
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue }
      if (!name.endsWith('.tsx')) continue
      const source = stripComments(readFileSync(full, 'utf8'))
      for (const tag of buttonTags(source)) {
        const kind = classify(tag, source, full, cssIndex)
        counts.total++
        counts[kind]++
        const rec = perFile.get(full) ?? {}
        rec[kind] = (rec[kind] ?? 0) + 1
        perFile.set(full, rec)
      }
    }
  }
  walk(root)
  return { counts, perFile }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootArg = process.argv[process.argv.indexOf('--root') + 1]
  if (!rootArg || rootArg.startsWith('--')) {
    console.error('ui-button-adoption: missing required --root <dir>')
    process.exit(1)
  }
  const { counts, perFile } = scan(path.resolve(rootArg))
  const debt = counts['hover-only'] + counts['no-feedback']
  console.log(JSON.stringify(counts, null, 1))
  console.log(`\n债务(hover-only + no-feedback) = ${debt}   ← 下界:unresolved=${counts.unresolved} 未判定`)
  console.log(`分母说明:total=${counts.total} 里 no-class=${counts['no-class']} 由父组件供样式,不是债务`)
  console.log(`unresolved 是解析不开的类名来源(工厂/跨包/动态拼接),既非债务也非已采用 —— 它是仪器的盲区,不是产品的状态`)
  const top = [...perFile.entries()]
    .map(([f, r]) => [f, (r['hover-only'] ?? 0) + (r['no-feedback'] ?? 0)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  console.log('\n债务最多的文件:')
  for (const [f, n] of top) console.log(`  ${String(n).padStart(3)}  ${path.relative(process.cwd(), f)}`)
}
