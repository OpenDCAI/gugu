/**
 * @@@terminal-cjk-cell (#5586) — 顺序有意义:**西文归 JetBrains,中文落到 Sarasa**。
 *
 * 终端按格子排版,一格 = 西文字形宽,全角占两格。JetBrains 这类西文等宽字体没有汉字,
 * 中文原本回退到系统字体 —— 两套字体的宽度比凑不出整数(实测 1.661),每列多约 1px,
 * 一行排满攒出 ~82px ≈ 5 个汉字被裁掉。
 *
 * 所以在系统字体之前插一支自托管的 `Sarasa Mono SC`(styles/sarasa-mono.css),它带
 * `size-adjust: 120%`,汉字正好等于 JetBrains 西文的两倍宽 —— 比值 2.000、溢出归零,
 * 而西文一个像素都没动。❌ 别把 Sarasa 提到 JetBrains 前面:owner 2026-09-14 试过整支
 * 换成 Sarasa,「还是喜欢之前的字体」。
 *
 * ⚠️ 用户在设置里选了自己的字体时,那支会排在**最前面**(见 buildTerminalFontFamily),
 * 而 size-adjust 咬的是 JetBrains 的字宽 —— 换成别的西文字体会有零点几像素的残差。
 * 设置页为此写了提示,❌ 别靠调整回退顺序去「修」它。
 */
const TERMINAL_FONT_FALLBACKS = [
  'JetBrains Mono Variable',
  'JetBrains Mono',
  'Sarasa Mono SC',
  'Menlo',
  'Monaco',
  'Consolas',
  'monospace',
];

const CSS_GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

const quoteFontFamily = (fontFamily: string) => {
  const trimmed = fontFamily.trim();
  if (!trimmed) return '';
  if (CSS_GENERIC_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  if (/^(['"])[^,'"]+\1$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const splitFontFamilies = (fontFamily: string) => {
  const families: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (const char of fontFamily) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    }

    if (char === ',' && !quote) {
      families.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  families.push(current.trim());
  return families.filter(Boolean);
};

export const buildTerminalFontFamily = (fontFamily?: string) => {
  const customFontFamily = fontFamily?.trim();
  const families = customFontFamily
    ? [...splitFontFamilies(customFontFamily), ...TERMINAL_FONT_FALLBACKS]
    : TERMINAL_FONT_FALLBACKS;

  return Array.from(new Set(families.map(quoteFontFamily).filter(Boolean))).join(', ');
};

/**
 * @@@terminal-cjk-cell (#5586) — 字体**晚到**之后,必须把 xterm 的字宽缓存整个扔掉。
 *
 * xterm 的 DOM 渲染器不是直接把字画上去就完事:它先问一次 `WidthCache` 这个字形有多宽,
 * 再给这一格补一条 `letter-spacing = 应占宽 - 量到的宽`,把亚像素误差摊平
 * (DomRendererRowFactory: `spacing = width * cellWidth - widthCache.get(chars, ...)`)。
 *
 * 于是自托管字体就踩进一个坑:首帧量汉字时 Sarasa 还没下载完,量到的是系统字体的 13px,
 * 缓存写下 13;字体到位后真正画出来的是 15.6px,而那条按 13 算出来的 +2.6px 补偿还挂着 ——
 * 每个汉字多 2.6px,一行五十多个字就攒出 ~143px 顶出格子。**比不换字体时还宽。**
 *
 * `WidthCache.setFont` 在四个参数都没变时直接 return(源码里就写着 "skip if nothing changed"),
 * 所以把 `fontFamily` 原样再赋一次是无效的;DOM 渲染器也没有实现 `clearTextureAtlas`,
 * `terminal.clearTextureAtlas()` 对它是空操作。唯一的公开抓手是**让 fontFamily 真的变一次**:
 * 先换成一个不同但同样合法的栈,立刻换回来 —— 两次赋值都同步触发 `setFont` → `clear()`,
 * 中间隔不了一帧,所以屏幕上不会闪。
 */
export const flushTerminalWidthCache = (terminal: {
  options: { fontFamily?: string };
}) => {
  const stack = terminal.options.fontFamily;
  if (!stack) return;
  terminal.options.fontFamily = `${stack}, monospace`;
  terminal.options.fontFamily = stack;
};
