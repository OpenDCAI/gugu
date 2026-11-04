// @@@font-face-first-usable — 浏览器对 @font-face 只取生效那条 src 里**第一个认得的格式**,后面的永远不会被请求。
// 第三方 CSS 为了兼容老浏览器常写四种(devicon:eot / ttf / woff / svg),vite 照着 url() 把每一份都发进 dist ——
// devicon 一家就多出 9.7 MB 永远不被加载的字体(手机包、桌面包都带)。这里把每个 @font-face 收成那一条:
// 生效的 src(同一块里最后一条 src 声明)里，保留第一个认得的 url 之前的 local(),以及这个 url 本身。
// 认得的格式 = 现代引擎(Chromium / WebKit / Gecko)都认的 woff2 / woff / truetype / opentype(含可变字体的
// `-variations` 写法，如 fontsource 的 format('woff2-variations'));
// embedded-opentype(IE)与 svg 字体(老 iOS)谁都不认。一个都认不出来就抛错，❌ 原样放过。
import type { PluginCreator } from 'postcss'

const USABLE_FORMATS = new Set(['woff2', 'woff', 'truetype', 'opentype'])
const USABLE_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf'])

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      if (ch === quote && value[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function isUsableUrl(entry: string): boolean {
  const format = /format\(\s*["']?([\w-]+)["']?\s*\)/i.exec(entry)
  if (format) return USABLE_FORMATS.has(format[1].toLowerCase().replace(/-variations$/, ''))
  const url = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(entry)
  if (!url) return false
  const ext = /\.(\w+)(?:[?#].*)?$/.exec(url[1])
  return !!ext && USABLE_EXTENSIONS.has(ext[1].toLowerCase())
}

export function firstUsableFontSrc(src: string): string | null {
  const kept: string[] = []
  for (const entry of splitTopLevel(src)) {
    if (/^local\(/i.test(entry)) kept.push(entry)
    else if (isUsableUrl(entry)) return [...kept, entry].join(',')
  }
  return null
}

const fontFaceFirstUsable: PluginCreator<void> = () => {
  return {
    postcssPlugin: 'gugu-font-face-first-usable',
    // ⚠️ 必须是 Once,❌ AtRule 访问器:vite 发 url() 资源的 vite-url-rewrite 也是 Once,postcss 先跑完所有插件的
    // Once 才进访问器 —— 写成 AtRule 时 url() 早已被发进 dist,这里删了引用也删不掉文件(mac1 实测四个格式照发)。
    // vite 把它排在用户插件之后，所以这里的 Once 先跑。
    Once(root, { result }) {
      root.walkAtRules('font-face', (rule) => {
        const srcs: import('postcss').Declaration[] = []
        rule.walkDecls('src', (decl) => { srcs.push(decl) })
        if (srcs.length === 0) return
        const effective = srcs[srcs.length - 1]
        const trimmed = firstUsableFontSrc(effective.value)
        if (!trimmed) {
          throw effective.error(`[font-face-first-usable] no usable font format in src: ${effective.value} (${result.opts.from ?? 'unknown file'})`)
        }
        for (const decl of srcs.slice(0, -1)) decl.remove()
        effective.value = trimmed
      })
    },
  }
}
fontFaceFirstUsable.postcss = true
export default fontFaceFirstUsable
