const MARKDOWN_EXTENSIONS = ['md', 'mdx'];

/** Returns true if the file path points to a markdown file. */
export function isMarkdownPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? MARKDOWN_EXTENSIONS.includes(ext) : false;
}

/** Alias for {@link isMarkdownPath}. */
export const isMarkdownFile = isMarkdownPath;

// ---------------------------------------------------------------------------
// Monaco editor options
// ---------------------------------------------------------------------------

/**
 * 文件查看面板的 Monaco 选项。
 *
 * 这是一个**读文件**的面板,不是全屏 IDE 主编辑区:它常年只有几百像素宽,右边还挨着文件树。
 * Monaco 的默认装饰是按全屏设计的,照搬进来就成了恒定开销 —— 实机量过(面板 178px 宽时):
 * 左边 glyph 20 + 行号 39 + 装饰槽 26 = 85px,右边 minimap 16 + overview ruler 14 = 30px,
 * 合计 115px,正文只剩 63px。这 115px **不随面板变宽而缩**,面板越窄占比越离谱。
 *
 * 同一棵树里的 diff 编辑器(lib/codemirror/)本来就只有行号和细滚动条;
 * 这一份按同样「给人读」的标准把 Monaco 出厂装饰关掉。
 *
 * ⚠️ glyphMargin 全仓**没有任何东西往里画**(diff 那边的批注管理器画的是行装饰,不是 glyph),
 *    那 20px 是纯空白。❌ 别因为「IDE 都有」把它加回来 —— 要加先得有画进去的东西。
 */
export const DEFAULT_EDITOR_OPTIONS = {
  fontSize: 13,
  wordWrap: 'on' as const,
  automaticLayout: true,
  scrollBeyondLastLine: false,

  // --- 让位给正文 ---
  minimap: { enabled: false },
  lineNumbers: 'off' as const,
  glyphMargin: false,
  folding: false,
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  // 上面几样一关,左边就没有任何槽了,正文会直接贴着容器边。
  // 装饰槽是 Monaco 唯一能给正文左侧留白的口子 —— 拿它当阅读留白用。
  lineDecorationsWidth: 16,
  padding: { top: 16, bottom: 16 },
  rulers: [],

  // 与 diff 编辑器同一套细滚动条:两个面板并排时不该一粗一细。
  scrollbar: {
    vertical: 'auto' as const,
    horizontal: 'auto' as const,
    useShadows: false,
    verticalScrollbarSize: 4,
    horizontalScrollbarSize: 4,
    verticalSliderSize: 4,
    horizontalSliderSize: 4,
    alwaysConsumeMouseWheel: false,
  },

  renderWhitespace: 'selection' as const,
  cursorBlinking: 'smooth' as const,
  smoothScrolling: true,
  formatOnPaste: true,
  formatOnType: true,
};
