import tailwind from '@tailwindcss/postcss'
import fontFaceFirstUsable from './scripts/postcss-font-face-first-usable.mts'

export default {
  plugins: [
    // #1077 Tailwind v4：PostCSS 插件改为 @tailwindcss/postcss（自带 autoprefix，无需 autoprefixer）。
    tailwind(),
    fontFaceFirstUsable(),
  ],
}
