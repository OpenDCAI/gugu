// #6278 生成的默认脸不许带 mix-blend-mode:安卓模拟器的图形栈画那一层会整机挂死。
// 判据:① 反例存在 —— 原生 Notionists 对这批 seed 确实会带(否则②是空判);② 我们生成的一张都不带;
// ③ 脸不变 —— 除掉衣服图标那一层逐字一致,图标颜色按衣服走(白衣服两个变体改黑、其余保持白;
//    这张表是在 Chromium 里逐像素比出来的,见 dicebearAvatar.ts 的 @@@6278)。
// DiceBear 只装在 apps/desktop 这个包里(根目录没有),测试从 tests/ 出发解析不到,所以按包路径引。
import { createAvatar } from '../../../../apps/desktop/node_modules/@dicebear/core'
import { notionists } from '../../../../apps/desktop/node_modules/@dicebear/collection'
import { describe, expect, it } from 'vitest'
import { dicebearAvatarDataUri } from '../../../../apps/desktop/src/lib/dicebearAvatar'

const BACKGROUND = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf']
const SEEDS = Array.from({ length: 300 }, (_, i) => `seed-6278-${i}`)
const svgOf = (uri: string) => decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length))
const raw = (seed: string) => createAvatar(notionists, { seed, backgroundColor: BACKGROUND }).toJson()
/** 衣服图标那一层:原生写法带 style,改写后不带;两边都把整层抽掉再比。 */
const ICON_LAYER = /<g transform="translate\(396 278\)"( style="mix-blend-mode:difference")?>(?:<g[^>]*>[\s\S]*?<\/g>|[\s\S])*?<\/g>/

describe('#6278 默认脸不带 mix-blend-mode', () => {
  const blended = SEEDS.filter((seed) => raw(seed).svg.includes('mix-blend-mode'))

  it('原生 Notionists 在这批 seed 里确实会带(反例存在)', () => {
    expect(blended.length).toBeGreaterThan(30)
  })

  it('我们生成的脸一张都不带', () => {
    for (const seed of SEEDS) expect(svgOf(dicebearAvatarDataUri(seed)), seed).not.toContain('mix-blend-mode')
  })

  it('脸不变:除掉图标层逐字一致;图标颜色按衣服走', () => {
    for (const seed of blended.slice(0, 60)) {
      const before = raw(seed)
      const after = svgOf(dicebearAvatarDataUri(seed))
      expect(after.replace(ICON_LAYER, ''), seed).toBe(before.svg.replace(ICON_LAYER, ''))
      const icon = after.match(ICON_LAYER)?.[0] ?? ''
      const blackBody = ['variant01', 'variant03'].includes(String(before.extra.body))
      if (blackBody) expect(icon, `${seed} ${before.extra.body}`).not.toMatch(/(fill|stroke)="#fff"/)
      else expect(icon.replace(' style="mix-blend-mode:difference"', ''), `${seed} ${before.extra.body}`).toBe(before.svg.match(ICON_LAYER)?.[0].replace(' style="mix-blend-mode:difference"', ''))
    }
  })

  it('DiceBear 里每一个 body 变体配上图标都能生成(没有漏在表外的混合层)', () => {
    for (let v = 1; v <= 25; v += 1) {
      const body = `variant${String(v).padStart(2, '0')}`
      const svg = createAvatar(notionists, { seed: body, body: [body], bodyIcon: ['galaxy'], bodyIconProbability: 100 }).toString()
      if (!svg.includes('mix-blend-mode')) continue
      expect(['variant01', 'variant02', 'variant03', 'variant04', 'variant07', 'variant08', 'variant09', 'variant10'], body).toContain(body)
    }
  })
})
