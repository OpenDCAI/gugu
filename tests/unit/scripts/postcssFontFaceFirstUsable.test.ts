import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import fontFaceFirstUsable, { firstUsableFontSrc } from '../../../scripts/postcss-font-face-first-usable.mjs'

const run = (css: string) => postcss([fontFaceFirstUsable()]).process(css, { from: 'test.css' }).css

describe('font-face first usable src', () => {
  it('devicon: drops the legacy eot declaration and keeps only the ttf the browser actually loads', () => {
    // devicon@2.17 devicon.min.css, verbatim @font-face
    const css = '@font-face{font-family:"devicon";src:url("fonts/devicon.eot?qd25fp");src:url("fonts/devicon.eot?qd25fp#iefix") format("embedded-opentype"),url("fonts/devicon.ttf?qd25fp") format("truetype"),url("fonts/devicon.woff?qd25fp") format("woff"),url("fonts/devicon.svg?qd25fp#devicon") format("svg");font-weight:normal;font-style:normal;font-display:block}'
    const out = run(css)
    expect(out).toContain('src:url("fonts/devicon.ttf?qd25fp") format("truetype");')
    expect(out).not.toMatch(/\.eot|\.woff|\.svg/)
  })

  it('runs before a later Once plugin that collects url() — the way vite-url-rewrite emits font files', () => {
    const seen: string[] = []
    const urlCollector = { postcssPlugin: 'url-collector', Once(root: postcss.Root) { root.walkDecls((decl) => { seen.push(...(decl.value.match(/url\([^)]*\)/g) ?? [])) }) } }
    postcss([fontFaceFirstUsable(), urlCollector]).process('@font-face{font-family:d;src:url(d.eot);src:url(d.eot#iefix) format("embedded-opentype"),url(d.ttf) format("truetype"),url(d.woff) format("woff")}', { from: 'test.css' }).css
    expect(seen).toEqual(['url(d.ttf)'])
  })

  it('katex: keeps woff2, drops woff and ttf', () => {
    const css = '@font-face{font-display:block;font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}'
    expect(run(css)).toContain('src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}')
  })

  it('variable fonts: format("woff2-variations") counts as woff2 (fontsource @fontsource-variable/*)', () => {
    const css = "@font-face{font-family:'JetBrains Mono Variable';src:url(data:font/woff2;base64,d09GMgAB) format('woff2-variations')}"
    expect(run(css)).toBe(css)
  })

  it('keeps local() entries in front of the first usable url, and judges format-less urls by extension', () => {
    expect(firstUsableFontSrc('local("Sora"), url(a.eot), url(a.woff2), url(a.woff)')).toBe('local("Sora"),url(a.woff2)')
  })

  it('leaves a single-format font-face as it was', () => {
    const css = '@font-face{font-family:Sora;src:url(sora.woff2) format("woff2")}'
    expect(run(css)).toBe(css)
  })

  it('fails loudly when no entry is usable (negative control: the plugin really reads the format)', () => {
    expect(() => run('@font-face{font-family:x;src:url(x.eot) format("embedded-opentype"),url(x.svg) format("svg")}')).toThrow(/no usable font format/)
  })
})
