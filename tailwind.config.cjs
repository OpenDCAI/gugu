/** @type {import('tailwindcss').Config} */
// ⚠️ 本表只做 Tailwind v3 兼容覆盖(字阶 / 间距 / 圆角)。**颜色一律在 apps/desktop/src/styles/tokens.css**,
// 这里一条色都不留:原来那 20 条微信调色板(brand.green / bubble.sent / bg.sidebar …)全仓零消费者,
// 却和真正生效的 borderRadius 躺在同一个 theme.extend 里,读表的人分不清哪半是活的(Refs #6104 / F-16)。
// 阴影同理:原来这里平行定义了一份 boxShadow.{dropdown,modal,card,panel},与 tokens.css 同名不同值。
// design.md 的口径是「阴影全局清零,只有浮层可以 lift」⇒ 唯一一档是 tokens.css 的 --shadow-lift。
const config = {
  // #1077 Streamdown 输出 Tailwind 工具类(font-semibold / space-y-4 / bg-gray-* / dark:* 等),
  // 须把其 dist 纳入扫描,否则这些类不生成 → 消息 markdown 裸样式。pnpm 实体在 .pnpm 下。
  content: [
    './apps/desktop/src/**/*.{ts,tsx}',
    './apps/desktop/index.html',
    './node_modules/.pnpm/streamdown@*/node_modules/streamdown/dist/**/*.{js,mjs}',
  ],
  // #1077 Tailwind v4: dark 变体改用 tokens.css 的 @custom-variant 接 [data-theme=dark](v4 原生),
  // 不在 JS 配置里定 darkMode,避免与 @custom-variant 双重定义。
  theme: {
    extend: {
      fontFamily: {
        // #7333 系统字体,与 tokens.css 的 --font-family-system 同一条栈。
        system: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', 'sans-serif'],
      },
      fontSize: {
        // #7333 字级 12/14/16/20/24(行高在 tokens.css 的 @theme 里成对钉住)。
        xs: '12px',
        sm: '14px',
        md: '16px',
        lg: '20px',
        xl: '24px',
      },
      fontWeight: {
        regular: '400',
        medium: '500',
      },
      lineHeight: {
        base: '1.4',
      },
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
      },
      // @@@shape-table (Refs #6104) — assistant-ui design.md 的 8 档语义表,**定义处在
      // apps/desktop/src/styles/tokens.css**,这里只是 Tailwind 那半边的逐字等值副本。
      // ⚠️ 这张表与会话页 apps/desktop/src/session/renderer/index.css 的 @theme 进的是**同一个
      // document**(#2802 拆掉 shadow root 之后),同名 utility 谁后注入谁全文档赢 —— 从前
      // `full` 在这里是 50%、在那边是 v4 默认的 calc(infinity*1px),于是「打开一次会话页,
      // 全 app 的 rounded-full 从椭圆翻成胶囊」。两张表现在逐档相同,由
      // scripts/check-ui-visual-spec.mjs 的 radiusScaleParity 钉住。
      // 真要正圆用 --radius-circle(50%),❌ 别再劫持 full。
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '8px',
        // @@@shape-table surface(10px)—— 菜单 / popover / tooltip / select / combobox 那一档。
        // 它不是 Tailwind 的数字别名,是语义档自己的名字;会话页那张表早就有它,主 app 这张没有
        // ⇒ `rounded-surface` 从前只在「会话页也加载了」的时候才成立,主 app 单开时静默落空
        // (Tailwind v4 对表里没有的 key 是整条丢掉 utility,不报错)。
        surface: '12px',
        xl: '12px',
        '2xl': '16px',
        '3xl': '20px',
        '4xl': '24px',
        full: '9999px',
      },
      width: {
        sidebar: '55px',
        'chat-list': '195px',
      },
    },
  },
  plugins: [],
}

module.exports = config
