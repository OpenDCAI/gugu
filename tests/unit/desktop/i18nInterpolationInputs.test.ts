import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages'

const ROOT = join(__dirname, '../../..')
const LOCALES = join(ROOT, 'apps/desktop/src/i18n/locales')
const LANGS = ['en-US', 'zh-CN'] as const
type Catalog = Record<string, unknown>

function flatten(tree: Catalog, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [[path, value] as [string, string]]
      : value && typeof value === 'object' ? flatten(value as Catalog, path) : []
  })
}

function variables(value: string, session: boolean): string[] {
  const pattern = session ? /\{([a-zA-Z][a-zA-Z0-9]*)\}/g : /\{\{\s*([\w.]+)(?:,[^}]+)?\s*\}\}/g
  return [...new Set([...value.matchAll(pattern)].map(match => match[1]))]
}

/** Check what a literal call actually supplies; forwarded value objects are checked by their callers. */
function missingInputs(call: ts.CallExpression, required: string[]): string[] {
  const values = call.arguments[1]
  if (!values) return required
  if (!ts.isObjectLiteralExpression(values) || values.properties.some(ts.isSpreadAssignment)) return []
  const names = values.properties.flatMap(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? [property.name.text] : [])
  return required.filter(name => !names.includes(name))
}

function calls(text: string, file: string): ts.CallExpression[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('locale interpolation inputs', () => {
  it.each(LANGS)('renders the assistant renewal description with its name in %s', async lang => {
    const { default: assistant } = await import(join(LOCALES, lang, 'assistant.ts')) as { default: Catalog }
    const instance = createInstance()
    await instance.init({ lng: lang, resources: { [lang]: { assistant } }, interpolation: { escapeValue: false } })
    const message = instance.t('move.expiredBody', { ns: 'assistant', name: 'Lumen' })
    expect(message).toContain('Lumen')
    expect(message).not.toMatch(/[{}]/)
  })

  it('detects omitted and incomplete inputs without rejecting forwarded values', () => {
    const [omitted, incomplete, supplied, forwarded] = calls("t('key'); t('key', { other: 1 }); t('key', { agent: name }); t('key', values)", 'fixture.ts')
    expect(missingInputs(omitted, ['agent'])).toEqual(['agent'])
    expect(missingInputs(incomplete, ['agent'])).toEqual(['agent'])
    expect(missingInputs(supplied, ['agent'])).toEqual([])
    expect(missingInputs(forwarded, ['agent'])).toEqual([])
  })

  it('uses each namespace delimiter and supplies literal interpolation inputs in both locales', async () => {
    const catalogs = new Map<string, Map<string, string[]>>()
    const problems: string[] = []
    for (const lang of LANGS) {
      const namespaces = readdirSync(join(LOCALES, lang)).filter(file => file.endsWith('.ts'))
      const resources: Array<[string, Array<[string, string]>]> = [
        ['session', Object.entries(lang === 'en-US' ? enUSMessages : zhCNMessages)],
      ]
      for (const file of namespaces) {
        const { default: tree } = await import(join(LOCALES, lang, file)) as { default: Catalog }
        resources.push([file.slice(0, -3), flatten(tree)])
      }
      for (const [namespace, entries] of resources) {
        const variablesByKey = new Map<string, string[]>()
        for (const [key, value] of entries) {
          // This string is a deferred main-process preview template, whose protocol replaces {machine}.
          // It deliberately reaches chat-folder-preview.ts without i18next interpolating it.
          const deferredPreview = namespace === 'messaging' && key === 'attachmentView.besideOffline'
          const wrongDelimiter = namespace === 'session'
            ? /\{\{\s*[a-zA-Z]\w*\s*\}\}/.test(value)
            : !deferredPreview && /(?<!\{)\{[a-zA-Z]\w*\}(?!\})/.test(value)
          if (wrongDelimiter) problems.push(`${lang}:${namespace}:${key}: wrong interpolation delimiter`)
          const inputs = variables(value, namespace === 'session')
          if (inputs.length) {
            const lookup = key.replace(/_(zero|one|two|few|many|other)$/, '')
            variablesByKey.set(key, inputs)
            variablesByKey.set(lookup, [...new Set([...(variablesByKey.get(lookup) ?? []), ...inputs])])
          }
        }
        catalogs.set(`${lang}:${namespace}`, variablesByKey)
      }
    }
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages'], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\.|\.d\.ts$|\/locales\/|\/localization\/messages/.test(file))
    let checked = 0
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      if (!/\b(?:translate|translateSessionMessage|useTranslation|i18n\.t)\b/.test(text)) continue
      const bindings = new Map<string, string>()
      for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*useTranslation\(\s*['"]([A-Za-z]+)['"]\s*\)/g)) {
        const binding = match[1].split(',').map(part => part.trim()).find(part => part === 't' || /^t\s*:/.test(part))
        if (!binding) continue
        const name = binding === 't' ? 't' : binding.split(':')[1].trim()
        bindings.set(name, bindings.has(name) && bindings.get(name) !== match[2] ? '' : match[2])
      }
      for (const call of calls(text, file)) {
        const key = (call.arguments[0] as ts.StringLiteralLike).text
        const callee = call.expression.getText()
        const namespace = /(?:^|\.)(?:translate|translateSessionMessage)$/.test(callee) ? 'session' : bindings.get(callee)
        const [explicitNS, lookup] = key.includes(':') ? key.split(':', 2) : [namespace, key]
        if (!explicitNS) continue
        for (const lang of LANGS) {
          const required = catalogs.get(`${lang}:${explicitNS}`)?.get(lookup)
          if (!required) continue
          checked++
          const missing = missingInputs(call, required)
          if (missing.length) {
            const source = call.getSourceFile()
            const line = source.getLineAndCharacterOfPosition(call.getStart()).line + 1
            problems.push(`${file}:${line} ${lang}:${explicitNS}:${lookup}: missing ${missing.join(', ')}`)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
    expect(problems).toEqual([])
  }, 20000)
})
