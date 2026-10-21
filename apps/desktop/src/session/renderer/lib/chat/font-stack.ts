/**
 * @@@font-single-source (#3334) — transcript 侧的字体规格。
 *
 * 与 `apps/desktop/src/styles/tokens.css` 的 `--font-family-system` / `--font-family-mono`
 * 是**同一份规格的第二次书写**,必须逐字一致。
 *
 * 为什么不能写成 `var(...)`:字体是 transcript 的**测量输入**,不只是外观。engine 用字体
 * 简写(`600 14px/20px <family>`)在离屏 canvas 上量字形宽度,那条路径拿不到 CSS 自定义属性。
 * session-chat-ui 的 spec 明写「宿主要换字体必须通过 context config 改变测量输入,不得只从 CSS
 * 覆盖实际 font-family」—— 两边不一致的后果不是「有点不好看」,是离屏量的字形和浏览器画的不是
 * 同一张脸,换行位置与行高整体错位。
 *
 * ❌ 改一处不改另一处。
 */
/**
 * ⚠️ 加家族 = 改测量输入,要 owner 单独拍板 —— **2026-09-19 拍了**(「开修,都修」),
 * 补的是 Windows 的对位:这条栈从前只点了 mac 的名,Windows 的中文落到系统兜底
 * (实测:Windows 正文中文的位图指纹等于该平台 generic sans,macOS 不等于)。
 *
 * 顺序保证 **mac 的解析结果逐字不变**(`PingFang SC` 仍在 `Microsoft YaHei` 之前命中,
 * `Segoe UI` 在 mac 上不存在被跳过)⇒ mac 侧的 pretext 测量输入没有变化。
 * Windows 侧测量与渲染读的是**同一条栈**,所以两者仍然一致 —— 这条注释担心的
 * 「离屏量的字形和浏览器画的不是同一张脸」不会发生。
 *
 * ⚠️ 与 `apps/desktop/src/styles/tokens.css` 逐字一致。
 */
/**
 * #7333 视觉规范:正文是系统字体(与 tokens.css `--font-family-system` 逐字一致,BlinkMacSystemFont 补在
 * -apple-system 后面)。会话页 transcript 的测量与绘制都读这一条(shared-chat-context 的 SESSION_CHAT_CONFIG),
 * 宿主外观(native-chat-appearance)也只引用它,❌ 再另写一条「原生」栈。
 */
export const SESSION_CHAT_FONT_STACK = {
  sans: [
    '-apple-system',
    'BlinkMacSystemFont',
    "'Segoe UI'",
    "'PingFang SC'",
    "'Microsoft YaHei'",
    "'Helvetica Neue'",
    'sans-serif',
  ],
  mono: [
    'JetBrains Mono Variable',
    'JetBrains Mono',
    'Menlo',
    'Monaco',
    'Cascadia Mono',
    'Consolas',
    'monospace',
  ],
} as const;
