import { tokenColor } from '../components/usage/useChartTheme'

/**
 * 二维码的深字浅底(theme batch D):`--qr-ink` / `--qr-paper`,两套主题同值 —— 扫码要对比度,不随主题变。
 * qrcode 画在 canvas / data URL 里,吃不到 CSS 变量,所以在渲染时(主题已套上)读出来交给它。
 * 读不到(主题还没挂上、不在页面环境里)⇒ 返回 undefined,不传 color:qrcode 用它自己的默认黑字白底,照样扫得出,
 * ❌ 交出空色画出一张没颜色的码;❌ 在这里再抄一份色值(tokens.css 是唯一的颜色来源)。
 */
export function qrColors(): { dark: string; light: string } | undefined {
  const dark = tokenColor('--qr-ink')
  const light = tokenColor('--qr-paper')
  return dark && light ? { dark, light } : undefined
}
