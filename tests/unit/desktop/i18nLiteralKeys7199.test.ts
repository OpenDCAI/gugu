import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// #7199 主界面的 `t()` 收任何字符串(没给 i18next 声明键的类型),拼错的键类型检查拦不住,画出来就是原始键名
// (实例:语音笔记设置里 t('needsCalendar'),词条其实在 meeting 下面)。这里把每个文件里
// `const { t } = useTranslation('<命名空间>')` 绑出来的 t,以字面量调用的键逐个对到中英两份词条上。
// 只认字面量键:拼出来的键(模板字符串、变量)与带「命名空间:」前缀的不在这里管。

const ROOT = join(__dirname, '../../..')
const SRC = join(ROOT, 'apps/desktop/src')
const LOCALES = join(SRC, 'i18n/locales')
const LANGS = ['zh-CN', 'en-US'] as const
const NAMESPACES = readdirSync(join(LOCALES, 'zh-CN')).map((file) => file.replace(/\.ts$/, ''))

type Catalog = Record<string, unknown>

async function catalog(lang: string, ns: string): Promise<Catalog> {
  return ((await import(join(LOCALES, lang, `${ns}.ts`))) as { default: Catalog }).default
}

function has(tree: Catalog, key: string): boolean {
  const lookup = (path: string) => {
    let node: unknown = tree
    for (const part of path.split('.')) {
      if (!node || typeof node !== 'object' || !(part in node)) return false
      node = (node as Catalog)[part]
    }
    return true
  }
  // 复数:t('x', { count }) 落到 x_one / x_other。
  return lookup(key) || lookup(`${key}_one`) || lookup(`${key}_other`)
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'locales') continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

/** 一个文件里 `const { t(: 别名)? } = useTranslation('ns')` 绑出来的名字 → 命名空间(带 keyPrefix 的不认)。 */
function bindings(text: string): Map<string, string> {
  const found = new Map<string, string>()
  const pattern = /const\s*\{([^}]*)\}\s*=\s*useTranslation\(\s*'([A-Za-z]+)'\s*\)/g
  for (const match of text.matchAll(pattern)) {
    const [, names, ns] = match
    if (!NAMESPACES.includes(ns)) continue
    const t = names.split(',').map((part) => part.trim()).find((part) => part === 't' || part.startsWith('t:'))
    if (!t) continue
    const name = t === 't' ? 't' : t.slice(2).trim()
    // 同一个名字在一个文件里绑到两个命名空间:分不清哪次调用属于哪一个,这个名字跳过。
    if (found.has(name) && found.get(name) !== ns) found.set(name, '')
    else found.set(name, ns)
  }
  return found
}

describe('界面里字面量写的 t() 键都在词条里', () => {
  it('中英两份都有(拼错的键 = 画出原始键名)', async () => {
    const missing: string[] = []
    let checked = 0
    const cache = new Map<string, Catalog>()
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('useTranslation(')) continue
      for (const [name, ns] of bindings(text)) {
        if (!ns) continue
        const call = new RegExp(`(?<![\\w.$])${name}\\(\\s*'([^'\\\\]+)'([^)]*)`, 'g')
        for (const match of text.matchAll(call)) {
          const [, key, rest] = match
          if (key.includes(':')) continue
          // 注释里举的例子(`t('…')`)不算。
          const lineStart = text.lastIndexOf('\n', match.index) + 1
          const before = text.slice(lineStart, match.index)
          if (before.includes('//') || before.trimStart().startsWith('*')) continue
          // t('key', { ns: 'other' }):这一次查的是另一个命名空间。
          const target = /\bns:\s*'([A-Za-z]+)'/.exec(rest)?.[1] ?? ns
          if (!NAMESPACES.includes(target)) continue
          checked += 1
          for (const lang of LANGS) {
            const id = `${lang}/${target}`
            if (!cache.has(id)) cache.set(id, await catalog(lang, target))
            if (!has(cache.get(id)!, key)) missing.push(`${relative(ROOT, file)} → ${target}:${key} (${lang})`)
          }
        }
      }
    }
    // 判据真在读:主界面这几千处字面量键,读到的少于这个数 = 绑定的认法坏了(❌ 一处没查就判绿)。
    expect(checked).toBeGreaterThan(1500)
    expect(missing).toEqual([])
  })
})
