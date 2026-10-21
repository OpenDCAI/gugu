/**
 * 会话页终端的 16 个基础色必须随主题给全,并且字色落在底色上低于正文对比度时,
 * 画出来的字要被调到读得清(#5655)。
 *
 * 缺任何一个基础色,xterm 就回落到为黑底设计的内置色板 —— 浅色主题下白/亮白/亮黄
 * 在白底上读不出来。对比度调整发生在渲染器画字那一步,所以这里在真 Chromium 里
 * 挂载、写字、读回画出来的颜色,而不是只断言配置项。两种渲染器都读:挂着露着的终端用 WebGL
 * (读 GL 绘制缓冲里的像素),挂上时页没露着的终端用 DOM(读行里 span 的颜色)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

// 每个基础色取互不相同的值,读错任何一个变量(或回落到默认 #000000)都会对不上。
const ANSI_VARS = {
  black: ['--xterm-ansi-black', '#010203'],
  red: ['--xterm-ansi-red', '#aa0001'],
  green: ['--xterm-ansi-green', '#00aa02'],
  yellow: ['--xterm-ansi-yellow', '#aaaa03'],
  blue: ['--xterm-ansi-blue', '#0000a4'],
  magenta: ['--xterm-ansi-magenta', '#aa00a5'],
  cyan: ['--xterm-ansi-cyan', '#00aaa6'],
  white: ['--xterm-ansi-white', '#555557'],
  brightBlack: ['--xterm-ansi-bright-black', '#666668'],
  brightRed: ['--xterm-ansi-bright-red', '#ff0009'],
  brightGreen: ['--xterm-ansi-bright-green', '#00ff0a'],
  brightYellow: ['--xterm-ansi-bright-yellow', '#ffff0b'],
  brightBlue: ['--xterm-ansi-bright-blue', '#0000fc'],
  brightMagenta: ['--xterm-ansi-bright-magenta', '#ff00fd'],
  brightCyan: ['--xterm-ansi-bright-cyan', '#00fffe'],
  // 白底上对比度 1.16 —— 正是 xterm 内置色板让浅色主题读不出来的那个亮白。
  brightWhite: ['--xterm-ansi-bright-white', '#eeeeec'],
} as const;

const BASE_VARS: Record<string, string> = {
  '--xterm-bg': '#ffffff',
  '--xterm-fg': '#171717',
  '--xterm-cursor': '#171717',
  '--xterm-cursor-accent': '#ffffff',
  '--xterm-selection-bg': '#cce0ff',
  '--xterm-selection-fg': '#000000',
};

function allVars(): Array<[string, string]> {
  return [...Object.entries(BASE_VARS), ...Object.values(ANSI_VARS).map(([name, value]) => [name, value] as [string, string])];
}

function relativeLuminance([r, g, b]: number[]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastAgainstWhite(cssColor: string): number {
  const match = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`unparseable rendered color: ${cssColor}`);
  const luminance = relativeLuminance([Number(match[1]), Number(match[2]), Number(match[3])]);
  return (1 + 0.05) / (luminance + 0.05);
}

function contrastOf([r, g, b]: number[]): number {
  return (1 + 0.05) / (relativeLuminance([r, g, b]) + 0.05);
}

function glContextOf(element: HTMLElement): WebGL2RenderingContext {
  // .xterm-screen 下的画布都已经有上下文(WebGL 的字形层或 2D 的链接层):要 'webgl2' 只会拿到已有的那个或 null。
  for (const canvas of element.querySelectorAll('canvas')) {
    const gl = canvas.getContext('webgl2');
    if (gl) return gl;
  }
  throw new Error('mounted terminal has no WebGL canvas');
}

/** 下一次渲染刚画完时(同一个任务里,绘制缓冲还在),画布上对白底对比度最高的那个像素。 */
function strongestGlContrastOnNextRender(terminal: import('@xterm/xterm').Terminal): Promise<number> {
  return new Promise((resolve) => {
    const once = terminal.onRender(() => {
      once.dispose();
      const gl = glContextOf(terminal.element!);
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let best = 1;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        best = Math.max(best, contrastOf([px[i], px[i + 1], px[i + 2]]));
      }
      resolve(best);
    });
    terminal.refresh(0, terminal.rows - 1);
  });
}

function renderedColorOf(root: HTMLElement, text: string): string {
  const span = Array.from(root.querySelectorAll<HTMLElement>('.xterm-rows span')).find((el) =>
    el.textContent?.includes(text)
  );
  if (!span) throw new Error(`no rendered span contains ${text}`);
  return getComputedStyle(span).color;
}

describe('terminal palette and contrast floor (#5655)', () => {
  let mountTarget: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ success: true, data: { buffer: '' } })),
    });
    for (const [name, value] of allVars()) {
      document.documentElement.style.setProperty(name, value);
    }
    mountTarget = document.createElement('div');
    Object.assign(mountTarget.style, { width: '640px', height: '320px' });
    document.body.appendChild(mountTarget);
  });

  afterEach(async () => {
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    mountTarget.remove();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    for (const [name] of allVars()) {
      document.documentElement.style.removeProperty(name);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads all 16 ANSI colors from the theme variables', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('palette-read');
    const theme = pty.terminal.options.theme as Record<string, string | undefined>;

    for (const [key, [, value]] of Object.entries(ANSI_VARS)) {
      expect(theme[key], key).toBe(value);
    }
  });

  // The palette is computed when the app theme changes, not on every mount; an override names a CSS
  // variable so the terminal tab's background follows the theme like the rest of the palette.
  it('follows an app theme change through applyThemeToAll, override included, and a remount does not rebuild it', async () => {
    const { FrontendPty, applyThemeToAll } = await getPtyModule();
    document.documentElement.style.setProperty('--background', '#fafafa');
    const pty = new FrontendPty('palette-theme');
    const override = { background: '--background' } as const;
    pty.setTheme({ override });
    const before = pty.terminal.options.theme;
    expect(before?.background).toBe('#fafafa');
    expect(before?.foreground).toBe('#171717');

    pty.setTheme({ override });
    expect(pty.terminal.options.theme, 'same override → palette untouched').toBe(before);

    document.documentElement.style.setProperty('--background', '#101010');
    document.documentElement.style.setProperty('--xterm-fg', '#eeeeee');
    applyThemeToAll();
    expect(pty.terminal.options.theme?.background).toBe('#101010');
    expect(pty.terminal.options.theme?.foreground).toBe('#eeeeee');
    document.documentElement.style.removeProperty('--background');
  });

  it('WebGL: draws low-contrast text at the readable floor, and not without it', async () => {
    const { FrontendPty, TERMINAL_MINIMUM_CONTRAST_RATIO } = await getPtyModule();
    const pty = new FrontendPty('palette-contrast-webgl');
    pty.mount(mountTarget);
    // 光标藏起来:它是 #171717 的实心块,对比度最高的像素会是它而不是字。
    await new Promise<void>((resolve) => pty.terminal.write('\x1b[?25l\x1b[97mREAD-ME\x1b[0m', resolve));
    await waitForFrames(2);
    const floored = await strongestGlContrastOnNextRender(pty.terminal);
    expect(floored).toBeGreaterThanOrEqual(TERMINAL_MINIMUM_CONTRAST_RATIO - 0.05);

    // 对照:关掉下限,同一行应当画回那个读不出来的亮白 —— 证明上面的读数不是恒真。
    pty.terminal.options.minimumContrastRatio = 1;
    await waitForFrames(2);
    const unfloored = await strongestGlContrastOnNextRender(pty.terminal);
    expect(unfloored).toBeLessThan(1.5);
  });

  it('DOM: draws low-contrast text at the readable floor, and not without it', async () => {
    const { FrontendPty, TERMINAL_MINIMUM_CONTRAST_RATIO } = await getPtyModule();
    const pty = new FrontendPty('palette-contrast');
    expect(pty.terminal.options.minimumContrastRatio).toBe(TERMINAL_MINIMUM_CONTRAST_RATIO);

    pty.setShown(false); // 挂上时所在的页没露着:不开 WebGL,走 DOM 渲染器
    pty.mount(mountTarget);
    await new Promise<void>((resolve) => pty.terminal.write('\x1b[97mREAD-ME\x1b[0m', resolve));
    await waitForFrames(4);
    const floored = contrastAgainstWhite(renderedColorOf(mountTarget, 'READ-ME'));
    expect(floored).toBeGreaterThanOrEqual(TERMINAL_MINIMUM_CONTRAST_RATIO - 0.05);

    // 对照:关掉下限,同一行应当画回那个读不出来的亮白 —— 证明上面的读数不是恒真。
    pty.terminal.options.minimumContrastRatio = 1;
    pty.terminal.refresh(0, pty.terminal.rows - 1);
    await waitForFrames(4);
    const unfloored = contrastAgainstWhite(renderedColorOf(mountTarget, 'READ-ME'));
    expect(unfloored).toBeLessThan(1.5);
  });
});
