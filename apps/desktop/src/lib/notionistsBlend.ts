// @@@6278 Notionists 约三分之一的脸,衣服上的小图标(bodyIcon,白色)那层带 `mix-blend-mode:difference`。
// 安卓模拟器的图形栈画这一层会整机挂死(截图卡住、qemu 退出):带它的账号一登录就崩,同一张脸去掉这一个属性就不崩。
// 去掉混合、按衣服改写图标颜色,画出来与原生逐像素相同(8 个变体 × 3 个图标在 Chromium 里实测,差 ≤1 像素):
// 白衣服的两个变体图标本来就显成黑色 → 改黑;其余变体图标显成白色 → 保持白。脸的其余部分逐字不变。
const BLACK_ICON_BODIES = new Set(['variant01', 'variant03'])
const WHITE_ICON_BODIES = new Set(['variant02', 'variant04', 'variant07', 'variant08', 'variant09', 'variant10'])
export function withoutBlend(svg: string, body: string): string {
  const blend = ' style="mix-blend-mode:difference"'
  const at = svg.indexOf(blend)
  if (at === -1) return svg
  if (svg.includes(blend, at + 1) || !(BLACK_ICON_BODIES.has(body) || WHITE_ICON_BODIES.has(body))) {
    throw new Error(`[Avatar] unexpected Notionists blend layer (body ${body}) — DiceBear 升级后要重新实测这张表`)
  }
  const start = svg.indexOf('>', at) + 1
  if (WHITE_ICON_BODIES.has(body)) return svg.slice(0, at) + svg.slice(at + blend.length)
  const tag = /<(\/?)g\b[^>]*?(\/?)>/g
  tag.lastIndex = start
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = tag.exec(svg)) && (depth += m[1] ? -1 : m[2] ? 0 : 1) > 0);
  if (!m) throw new Error('[Avatar] unbalanced Notionists blend layer')
  const icon = svg.slice(start, m.index).replace(/(fill|stroke)="#fff"/g, '$1="#000"')
  return svg.slice(0, at) + svg.slice(at + blend.length, start) + icon + svg.slice(m.index)
}
