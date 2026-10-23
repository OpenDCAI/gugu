import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import { events, rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { cssColorToHex, cssVar } from '@renderer/utils/cssVars';
import { log } from '@renderer/utils/logger';
import { ptyDataChannel } from '@shared/core/pty/ptyEvents';
import { FileLinkProvider, isPrimaryMouseButton } from './file-link-provider';
import { sendTerminalInput } from './send-terminal-input';
import { decodeOsc52ClipboardData } from './pty-clipboard';
import { keepCompositionInsideGrid } from './composition-fit';
import { buildTerminalFontFamily } from './terminal-font';
import { terminalHasVisibleContent } from './terminal-visible-content';
import { ensureXtermHost } from './xterm-host';
import { notifyPtyOutput } from '../session-output-observers';

/**
 * 每个终端视图在渲染进程里留多少行回滚。普通终端页签关闭时释放视图,重开从主进程屏幕恢复。
 * 从前是 100,000 行。macOS A/B(同一个终端写满 15 万行输出,改前改后交替各 2 轮):渲染进程 286–288MB → 198–203MB;
 * 工作区面板「最大化 / 还原」三次 —— 每次改宽度 xterm 都把整份回滚重排一遍 —— 主线程长任务 21–24 个、最长 134–140ms
 * → 5–8 个、最长 64–65ms(2026-10-05 实测)。
 * 普通终端在 LocalTerminalProvider 中使用同样的主进程回滚上限,视图重建不能丢掉更早的回滚。
 */
const SCROLLBACK_LINES = 10_000;

/**
 * Replaying a terminal's history can be genuinely slow on a cold machine. Keep the
 * budget large enough for that work to finish, following verify-dev-native's
 * probe-timeout rule: the deadline is for a hung parser, not for racing slow
 * but valid replay. A timeout still ends the gate so live output cannot stay
 * black forever.
 */
export const HISTORY_REPLAY_WRITE_TIMEOUT_MS = 120_000;

export const TERMINAL_PADDING_PX = 8;
/**
 * @@@ime-edge (#6547) 挂终端那一层的 overflow:clip ❌ hidden。hidden 仍是滚动容器:输入法组合时
 * 有焦点的 helper textarea 伸出右边缘,浏览器为露出输入光标会把这一层横向滚走 —— 整屏往左偏
 * 几十上百像素,上屏后还停在那里。clip 不可滚,浏览器无从滚它。拼音浮层本身怎么摆见 composition-fit.ts。
 */
export const TERMINAL_CONTAINER_OVERFLOW = 'clip';
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_LETTER_SPACING = 0;

/**
 * 字色与底色太接近时,xterm 把字自动调深/调浅到这个对比度(WCAG 公式,1 = 不调)。
 * 4.5 = VS Code 用同一个库时的默认值。16 色、程序自己指定的真彩色、默认字色三条路都兜住 ——
 * agent TUI 按它自己以为的底色挑出来的字,落在咕咕的底色上也读得清(#5655)。
 */
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

// ── Theme helpers ─────────────────────────────────────────────────────────────

export interface SessionTheme {
  /** xterm color key → CSS custom property name; resolved with the rest of the palette, so it follows theme changes. */
  override?: Partial<Record<keyof NonNullable<ITerminalOptions['theme']>, string>>;
}

type TerminalInputHandler = (data: string) => void;

export function readXtermCssVars(): ITerminalOptions['theme'] {
  const color = (name: string) => cssColorToHex(cssVar(name));
  return {
    background: color('--xterm-bg'),
    foreground: color('--xterm-fg'),
    cursor: color('--xterm-cursor'),
    cursorAccent: color('--xterm-cursor-accent'),
    selectionBackground: color('--xterm-selection-bg'),
    selectionForeground: color('--xterm-selection-fg'),
    // 16 个基础色必须随主题给全:缺一个就回落到 xterm 为黑底设计的内置色板,
    // 浅色下白/亮白/亮黄落在白底上读不出来(#5655)。
    black: color('--xterm-ansi-black'),
    red: color('--xterm-ansi-red'),
    green: color('--xterm-ansi-green'),
    yellow: color('--xterm-ansi-yellow'),
    blue: color('--xterm-ansi-blue'),
    magenta: color('--xterm-ansi-magenta'),
    cyan: color('--xterm-ansi-cyan'),
    white: color('--xterm-ansi-white'),
    brightBlack: color('--xterm-ansi-bright-black'),
    brightRed: color('--xterm-ansi-bright-red'),
    brightGreen: color('--xterm-ansi-bright-green'),
    brightYellow: color('--xterm-ansi-bright-yellow'),
    brightBlue: color('--xterm-ansi-bright-blue'),
    brightMagenta: color('--xterm-ansi-bright-magenta'),
    brightCyan: color('--xterm-ansi-bright-cyan'),
    brightWhite: color('--xterm-ansi-bright-white'),
  };
}

export function buildTheme(theme?: SessionTheme): ITerminalOptions['theme'] {
  const resolved = readXtermCssVars();
  for (const [key, cssVarName] of Object.entries(theme?.override ?? {})) {
    (resolved as Record<string, string>)[key] = cssColorToHex(cssVar(cssVarName));
  }
  return resolved;
}

// @@@xterm-on-demand — xterm 随第一个终端加载，不随应用启动加载。这个文件经任务页的 store 链静态可达，
// 咕咕主界面(手机也是)启动时就会执行它;静态 import xterm 等于每次启动都多解析 0.33 MB 的终端引擎。
// FrontendPty 只在 PtySession.connect()(本就是异步)里构造，那里先 await loadXterm()。
let xterm: {
  Terminal: typeof Terminal;
  WebLinksAddon: typeof WebLinksAddon;
  WebglAddon: typeof WebglAddon;
} | null = null;
let xtermLoading: Promise<void> | null = null;

export function loadXterm(): Promise<void> {
  xtermLoading ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-webgl'),
  ]).then(([core, links, webgl]) => {
    xterm = { Terminal: core.Terminal, WebLinksAddon: links.WebLinksAddon, WebglAddon: webgl.WebglAddon };
  });
  return xtermLoading;
}

// ── FrontendPty ───────────────────────────────────────────────────────────────

/**
 * @@@webgl-hot-terminals — 最近露过面的这么多个终端留着 GL 上下文(切回来不重建),再往前的退回 DOM 渲染器。
 * 每留一个都要占内存:Windows 集显上实测每个约 +60–75MB 工作集(大半是 GPU 共享内存,私有 +10–15MB),
 * 字形贴图随 CJK 字数长到 4 页时再 +40MB。3 个让两三个任务之间来回切都是热的,比任务页留着的页
 * (recent-session-pages)少;第 4 个起的留着的页切回来走一次重建。
 */
export const WEBGL_HOT_TERMINALS = 3;
/** 握着 GL 上下文的终端,最近露面的在最后。 */
const webglHolders: FrontendPty[] = [];

/**
 * Frontend counterpart to the main-process Pty interface.
 *
 * Owns the xterm Terminal instance for the full lifetime of the session.
 * The terminal is created synchronously during construction and opened into
 * an off-screen container. Call connect() to fetch the main-process screen
 * snapshot and subscribe to live IPC events — this writes the snapshot directly
 * to xterm and sets up ongoing data delivery without any renderer-side buffer.
 *
 * DOM management is handled via mount() / unmount():
 *  - mount()   → appends ownedContainer to the visible mount target
 *  - unmount() → moves ownedContainer back to the off-screen host
 *
 * Lifecycle: created and owned by PtySession (stores/pty-session.ts), one per
 * live session. Survives React component unmounts (e.g. navigating away from a
 * task). Closing a normal terminal tab or deleting its entity disposes the view.
 */
export class FrontendPty {
  /** All live FrontendPty instances — used for app-wide operations (e.g. theme updates). */
  static readonly all = new Set<FrontendPty>();
  /** Lookup from session ID to live FrontendPty — used by the resize controller to fan out grid resizes. */
  static readonly byPtySession = new Map<string, FrontendPty>();
  readonly terminal: Terminal;
  readonly ownedContainer: HTMLDivElement;
  private theme?: SessionTheme;
  private offData: (() => void) | null = null;
  private inputHandler: TerminalInputHandler | null = null;
  private readonly inputDisposable: { dispose(): void };
  /** 输入法拼音浮层放不下时挪回网格内(#6547,见 composition-fit.ts)。 */
  private readonly compositionFit: { dispose(): void };
  /** Live PTY output that arrives while the screen snapshot is replayed. */
  private pendingLiveData: string[] = [];
  private replayingHistory = false;
  /** Pending post-mount repaint frame, owned by this instance so it cannot outlive the terminal. */
  private repaintFrame: number | null = null;
  /** The window whose frame `repaintFrame` was asked of (the terminal can live in a block's own window, #7052). */
  private repaintView: Window | null = null;
  private disposed = false;
  /** 挂上来之后 xterm 整屏画过一次了吗;没有之前行 DOM 还是离屏时的半成品(见 mount)。 */
  private paintedOnce = false;
  private revealOnRender: { dispose(): void } | null = null;
  /** 挂着时的 GPU 渲染器,以及它的画布建在哪扇窗里(见 attachWebgl)。 */
  private webgl: { addon: WebglAddon; paintOnResize: { dispose(): void } } | null = null;
  private webglView: Window | null = null;
  /** 挂在界面上没有(mount / unmount),以及所在的页露没露着(setShown)。两者都成立才用 WebGL。 */
  private mounted = false;
  private shown = true;
  /** Last { cols, rows } sent to rpc.pty.resize(). Used by PaneSizingContext to skip redundant IPC calls. */
  lastSentDims: { cols: number; rows: number } | null = null;
  /**
   * 终端第一次真的有内容写进来时回调一次（历史回放算，实时输出也算）。
   * 为什么需要它：`status === 'ready'` 只代表**管道通了**，不代表**有东西可看**。
   * agent 起来之前终端是一片空白 + 左上角一个闪烁光标 —— owner 实测把这一段读成
   * 「还有个老的加载态在」。加载态该等到真有内容才撤。
   */
  onFirstOutput: (() => void) | null = null;
  private sawOutput = false;

  /**
   * 缓冲区里有没有**一个可见字符**。
   *
   * ⚠️ 判据必须是这个，❌ 不能是「有字节到达」：agent TUI 启动时最先发的是一串转义序列
   * （查询设备属性、清屏、定位光标 —— 见本文件 onData 那段注释），那些是字节，
   * 画面上什么也没有。按「有字节」撤加载态 = 在纯转义序列那一刻就撤 = 等于没修。
   *
   * `translateToString(true)` 会裁掉行尾空白，所以整屏空格读作空 —— 一个只画背景色
   * 不画任何字形的 TUI 会被漏判（加载态多留一会）。已知且可接受：漏判方向是「多等」，
   * 不是「提前撤」。
   */
  private hasVisibleContent(): boolean {
    return terminalHasVisibleContent(this.terminal);
  }

  /** 每次写入**解析完成后**调一次；只在真的有可见内容时才放行。 */
  private noteOutput(): void {
    if (this.disposed || this.sawOutput) return;
    if (!this.hasVisibleContent()) return;
    this.sawOutput = true;
    this.onFirstOutput?.();
  }

  constructor(
    readonly ptySessionId: string,
    theme?: SessionTheme,
    onOpenFile?: (filePath: string) => void,
    onOpenExternal?: (filePath: string) => void
  ) {
    const lib = xterm;
    if (!lib) throw new Error('FrontendPty: xterm is not loaded yet — await loadXterm() before constructing');
    this.theme = theme;
    this.ownedContainer = document.createElement('div');
    Object.assign(this.ownedContainer.style, {
      width: '100%',
      height: '100%',
    });
    ensureXtermHost().appendChild(this.ownedContainer);

    this.terminal = new lib.Terminal({
      cols: 120,
      rows: 32,
      scrollback: SCROLLBACK_LINES,
      // NOTE: convertEol must stay false (the default). The PTY/app owns line
      // discipline; rewriting bare \n to \r\n corrupts raw-mode TUIs (tmux, claude
      // code) that use \n as "line feed, keep column" — yanking the cursor to
      // column 0 and mangling column alignment, while leaving plain shells fine.
      fontFamily: buildTerminalFontFamily(),
      fontSize: 13,
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: TERMINAL_LETTER_SPACING,
      allowProposedApi: true,
      scrollOnUserInput: false,
      linkHandler: {
        activate: (_event: MouseEvent, text: string) => {
          if (!isPrimaryMouseButton(_event)) return;
          confirmOpenExternalLink(text, (error) => {
            log.warn('FrontendPty: failed to open external link', { text, error });
          });
        },
      },
      theme: buildTheme(theme),
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
    });

    const webLinksAddon = new lib.WebLinksAddon((event, uri) => {
      if (!isPrimaryMouseButton(event)) return;
      event.preventDefault();
      confirmOpenExternalLink(uri);
    });

    this.terminal.loadAddon(webLinksAddon);
    if (onOpenFile && onOpenExternal) {
      this.terminal.registerLinkProvider(
        new FileLinkProvider(this.terminal, onOpenFile, onOpenExternal)
      );
    }

    // ── DECRQM(CSI ? Ps $ p)—— xterm.js 6.0 的 `requestMode` 在打包产物里抛
    //    `ReferenceError: s is not defined`(#4904)。它抛在 `_innerWrite` → `parse` 里,
    //    于是**这次 write 直接死掉、它的回调永远不跑** ⇒ `noteOutput()` 不被调用 ⇒
    //    `PtySession.hasOutput` 永为假 ⇒ 会话页永久停在「Starting session...」。
    //    opencode 的 `attach` 首屏正是要查 DECRQM 的那一家(#5132,2026-09-06 mac1 实测:
    //    日志里 `attaching pty` 之后 3.5s 出现该 ReferenceError,终端 60s 不上屏)。
    //
    //    `use-pty.ts` 早就为**终端标签页**那条路注册过同一个绕行,但会话终端走的是
    //    `FrontendPty` 这条路,它没有 ⇒ 同一个引擎缺陷在两条路上一条被挡住、一条没有。
    //    ⇒ 绕行放进 FrontendPty 自己:谁 new 它谁就自动带上,❌ 不在每个调用点各贴一份。
    const replyDecrqm = (prefix: string) => (params: (number | number[])[]) => {
      const mode = (params[0] as number) ?? 0;
      // 0 = mode not recognised。产品不依赖任何一个 DECRQM 的真值,这里只负责**别让解析器死掉**。
      if (!this.replayingHistory) {
        sendTerminalInput(this.ptySessionId, `\x1b[${prefix}${mode};0$y`);
      }
      return true;
    };
    this.terminal.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, replyDecrqm(''));
    this.terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, replyDecrqm('?'));

    this.terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52ClipboardData(data);
      if (text === null) return false;

      void rpc.app.clipboardWriteText(text).catch((error) => {
        log.warn('FrontendPty: failed to write OSC 52 clipboard payload', { error });
      });
      return true;
    });

    // xterm emits terminal protocol replies (OSC color reports, cursor position,
    // device attributes) through onData. Agent TUIs query these during startup,
    // before the visible pane mounts and installs its keyboard handler.
    this.inputDisposable = this.terminal.onData((data) => {
      if (this.replayingHistory) return;
      if (this.inputHandler) {
        this.inputHandler(data);
        return;
      }
      sendTerminalInput(this.ptySessionId, data);
    });

    this.terminal.open(this.ownedContainer);
    this.compositionFit = keepCompositionInsideGrid(this.terminal);

    // xterm v6 insets .xterm-screen by padding on the .xterm element and subtracts
    // padding-left/padding-top in its coordinate math (getCoordsRelativeToElement),
    // so padding must live here — not on the parent ownedContainer.
    const el = (this.terminal as unknown as { element?: HTMLElement }).element;
    if (el) {
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.boxSizing = 'border-box';
      el.style.padding = `${TERMINAL_PADDING_PX}px`;
      el.style.backgroundColor = 'var(--xterm-bg)';
    }

    FrontendPty.all.add(this);
    FrontendPty.byPtySession.set(this.ptySessionId, this);
  }

  /** The palette only changes with the app theme (→ refreshTheme) or with a different override, not per mount. */
  setTheme(theme?: SessionTheme): void {
    if (theme?.override === this.theme?.override) return;
    this.theme = theme;
    this.terminal.options.theme = buildTheme(theme);
  }

  refreshTheme(): void {
    this.terminal.options.theme = buildTheme(this.theme);
  }

  clear(): void {
    this.terminal.clear();
    this.terminal.clearSelection();
  }

  /**
   * 往终端里写一段**只给人看**的字:不经 pty、不进主进程的回放缓冲(#6264 别的机器上的终端断线时,
   * 最后一行「N 秒后重连」的倒计时每秒原地刷新 —— 进了回放缓冲会把真内容挤出去)。
   * 历史回放进行中就排在回放后面,❌ 插到回放中间。
   */
  writeLocal(text: string): void {
    if (this.disposed || !text) return;
    if (this.replayingHistory) {
      this.pendingLiveData.push(text);
      return;
    }
    this.terminal.write(text, () => this.noteOutput());
  }

  attachInputHandler(handler: TerminalInputHandler): () => void {
    if (this.inputHandler) {
      throw new Error(`FrontendPty ${this.ptySessionId} already has an attached input handler`);
    }
    this.inputHandler = handler;
    return () => {
      if (this.inputHandler === handler) this.inputHandler = null;
    };
  }

  /**
   * Subscribe to the session: fetches the screen snapshot from the main process
   * (pty-screen.ts — what is on screen plus the terminal modes, e.g. a TUI's
   * alternate screen and mouse tracking), writes it directly to xterm, then sets
   * up a live IPC listener for future data. Marks status as 'ready' once complete.
   *
   * The main process guarantees the hand-over: every batch the PTY produced up to
   * the reply is in the snapshot, and the batches after it are emitted after the reply.
   */
  async connect(): Promise<void> {
    const result = await rpc.pty.subscribe(this.ptySessionId);
    if (this.disposed) return;
    const historical = result.success ? result.data.buffer : '';
    // 要快照之后、切出来之前才到的新输出:排在回放后面照实时写,其中 TUI 刚发的查询(DA1、光标位置…)要应答。
    // 会话在别的机器上、那边还是旧版宿主时没有这一项。
    const live = result.success ? (result.data.live ?? '') : '';

    // 快照是按主进程那块屏幕(与 PTY 同一个网格)画的。在构造时那个占位网格(120×32)上回放,终端第一次挂出来
    // 就是错的那一版,挂载时再改到窗格网格 —— 冷切进会话时那一下「先错后改」的抽搐(实测首帧 32 行、
    // 下一帧 40 行,内容整体下移)。窗格不是 120 列时更糟:先按 120 列解析、再改回窗格列数,xterm 的
    // 重排是有损的,Claude Code 的输入框边框会被折成两截。先对齐到 PTY 自己的网格再回放;窗格没变时
    // 挂载就不必再改。
    const size = result.success ? result.data.size : null;
    if (size && (size.cols !== this.terminal.cols || size.rows !== this.terminal.rows)) {
      this.terminal.resize(size.cols, size.rows);
    }

    // Subscribe before replaying so the main-process snapshot has a live
    // delivery path. Snapshot bytes are old terminal output, not a new
    // conversation with the PTY: xterm must parse them for the screen, but any
    // protocol replies generated by that parse must not reach the live stdin.
    this.offData = events.on(
      ptyDataChannel,
      (data: string) => {
        notifyPtyOutput(this.ptySessionId, data);
        if (this.replayingHistory) {
          this.pendingLiveData.push(data);
          return;
        }
        this.terminal.write(data, () => this.noteOutput());
      },
      this.ptySessionId
    );

    if (!historical) {
      if (live) this.terminal.write(live, () => this.noteOutput());
      return;
    }

    this.replayingHistory = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const startedAt = performance.now();
        const timeout = window.setTimeout(() => {
          log.warn('FrontendPty: terminal history replay timed out; continuing with partial screen', {
            ptySessionId: this.ptySessionId,
            waitedMs: Math.round(performance.now() - startedAt),
          });
          resolve();
        }, HISTORY_REPLAY_WRITE_TIMEOUT_MS);

        try {
          // write 是异步解析的 —— 必须在**解析完成的回调里**看缓冲区，否则读到的是写入前的状态。
          this.terminal.write(historical, () => {
            window.clearTimeout(timeout);
            this.noteOutput();
            resolve();
          });
        } catch (error) {
          window.clearTimeout(timeout);
          reject(error);
        }
      });
    } finally {
      // Keep the flag set until the queued live chunks have been submitted to
      // xterm, so a live event cannot overtake one that was already buffered.
      this.replayingHistory = false;
      const pendingLiveData = live ? [live, ...this.pendingLiveData] : this.pendingLiveData;
      this.pendingLiveData = [];
      if (!this.disposed) {
        for (const data of pendingLiveData) this.terminal.write(data, () => this.noteOutput());
      }
    }
  }

  /**
   * Append ownedContainer to a visible mount target.
   * If targetDims are provided the terminal is resized BEFORE the appendChild
   * to eliminate the flash caused by a post-mount resize.
   */
  mount(mountTarget: HTMLElement): void {
    // A disposed session cannot be revived: the terminal is gone and ownedContainer is out of the
    // DOM, so mounting would reattach a dead container and schedule a repaint at a torn-down
    // RenderService. The product always builds a new FrontendPty instead, so reaching here is a
    // caller bug — say so rather than repainting a corpse.
    if (this.disposed) {
      throw new Error(`FrontendPty ${this.ptySessionId} is disposed; mount() cannot revive it`);
    }
    // 历史是在离屏宿主里回放的,那时 xterm 按 IntersectionObserver 暂停渲染,行 DOM 停在回放到一半的样子。
    // 第一次挂上来要等恢复渲染的那一帧才是真画面,之前那一帧(负载高时实测 30–168ms)就是半成品。
    // ⇒ 整屏画出来之前先透明。只管第一次:之后再挂,停着的 DOM 就是用户上次看到的画面,直接露出
    //    (❌ 按「离屏期间有写入」判:切走时终端失焦,TUI 会跟着重画一下,暖切换就平白多一帧空白)。
    //    用 opacity ❌ visibility:visibility:hidden 的元素拿不到焦点,切进会话时的自动聚焦会落空。
    this.cancelReveal();
    if (!this.paintedOnce) {
      this.ownedContainer.style.opacity = '0';
      this.revealOnRender = this.terminal.onRender(({ start, end }) => {
        if (start !== 0 || end !== this.terminal.rows - 1) return;
        this.paintedOnce = true;
        this.cancelReveal();
      });
    }
    mountTarget.appendChild(this.ownedContainer);
    // 挂到了另一扇窗里(一块会话单独成窗,#7052):xterm 记着自己画在哪扇窗(那扇窗的帧、像素比、可见性),
    // 换了窗要告诉它。已经打开过的终端再 open 一次只做这件事(xterm CoreBrowserTerminal.open)。
    this.terminal.open(this.ownedContainer);
    this.mounted = true;
    if (this.shown) this.attachWebgl();
    // @@@repaint frame ownership — the deferred repaint belongs to this instance, not to the frame
    // queue. A remount replaces it and dispose() cancels it, so no frame can reach a terminal that
    // is gone: refreshing a disposed terminal re-arms xterm's RenderDebouncer after RenderService
    // has been torn down, and the frame that schedules then runs the Viewport callbacks the
    // debouncer never cleared, throwing out of Viewport._sync where nothing is awaiting it (#3533).
    this.cancelRepaintFrame();
    // 用它此刻所在那扇窗的帧(主窗被遮住时,子窗里的终端照样要画)。
    const view = this.ownedContainer.ownerDocument.defaultView ?? window;
    this.repaintView = view;
    this.repaintFrame = view.requestAnimationFrame(() => {
      this.repaintFrame = null;
      this.terminal.refresh(0, this.terminal.rows - 1);
    });
  }

  private cancelRepaintFrame(): void {
    if (this.repaintFrame === null) return;
    (this.repaintView ?? window).cancelAnimationFrame(this.repaintFrame);
    this.repaintFrame = null;
  }

  /**
   * 所在的页还在不在屏幕上。任务页会把最近开过的几页留着不卸(recent-session-pages,藏起来时 PageShownContext 为 false)。
   * 藏起来时 GL 上下文留着:切回来不必重建字形贴图(mac1 实测,两个任务来回切,每次都拆了重建时点击到上屏 p50
   * 115ms,DOM 渲染器 80ms,留着 70ms)。留着的个数由 @@@webgl-hot-terminals 封顶。
   */
  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown && this.mounted) this.attachWebgl();
  }

  /**
   * @@@webgl-while-mounted — 挂在界面上、最近露过面的终端用 WebGL 画(个数见 @@@webgl-hot-terminals),其余的回到 DOM 渲染器。
   * DOM 渲染器每帧把每条脏行的 span 拆了重建,流式输出时样式重算、布局、绘制占满 renderer 主线程;
   * WebGL 是一次 GPU 提交(macOS 同一终端 codex 流式 80 秒:renderer CPU 18.9 → 9.8 秒,按键上屏快 11ms,
   * 2026-10-19 实测)。只给挂着的终端:每个 GL 上下文都占显存,Chromium 一页
   * 只给十几个,开过的会话终端会一直活到删除,全开 WebGL 必然撞上限。
   * 上下文丢了(GPU 进程重启、显存被回收)xterm 会先等 3 秒看能否恢复,恢复不了才报 onContextLoss:
   * 这一次挂载退回 DOM 渲染器,下次挂载再开。换了窗(一块会话单独成窗,#7052)画布要建在新窗里,重开一个。
   *
   * @@@webgl-paint-on-resize — 网格一变,WebGL 的画布就被清空(改 canvas.width 即清),xterm 要等下一帧 rAF 才重画;
   * 而改网格多半发生在 ResizeObserver 回调里(这一帧的 rAF 已过、马上上屏),于是这一帧上屏的是一张白板:
   * mac1 逐帧录屏,侧栏开合 12 次出现 36 帧白板、窗口改宽 12 次 6 帧(DOM 渲染器 0 帧)。⇒ 改完当场画一遍。
   * 直接交给渲染器画,❌ 走 RenderService 的 `_renderRows`:TUI 正在一个同步输出块(DEC 2026)里时它只记下
   * 脏行、不画,而 TUI 收到改尺寸就会重画,下一次改尺寸常常正落在这个块里(侧栏一次开合约 1/10 的改尺寸如此),
   * 画布于是空着等块结束 —— 照样闪(12 次开合 7–11 帧)。直接画后 24 次开合 0 帧。块里那一刻的画面可能是
   * 半新半旧的,但它只在改尺寸这一帧出现,而另一个选项是白板;块结束时 xterm 照常整块重画。
   * xterm 6.0.0 没有公开的同步渲染入口(`terminal.refresh` 也排 rAF),只能经私有的 `_core._renderService._renderer`
   * (与 xterm-cell-metrics.ts 读 `_core._renderService` 同一类依赖,版本在 package.json 钉死);
   * 它没了的话第一次改尺寸就直接抛出,浏览器单测 pty-webgl-resize-paint 也钉着它。
   */
  private attachWebgl(): void {
    const view = this.ownedContainer.ownerDocument.defaultView ?? window;
    if (this.webgl && this.webglView === view) {
      webglHolders.splice(webglHolders.indexOf(this), 1);
      webglHolders.push(this);
      return;
    }
    this.detachWebgl();
    const lib = xterm!;
    const addon = new lib.WebglAddon();
    try {
      this.terminal.loadAddon(addon);
    } catch (error) {
      // 这扇窗拿不到 WebGL2(GPU 被禁用 / 黑名单):留在 DOM 渲染器上,照样能用。
      log.warn('FrontendPty: WebGL renderer unavailable; using the DOM renderer', {
        ptySessionId: this.ptySessionId,
        error: String(error),
      });
      addon.dispose();
      return;
    }
    addon.onContextLoss(() => {
      log.warn('FrontendPty: WebGL context lost; using the DOM renderer until the next mount', {
        ptySessionId: this.ptySessionId,
      });
      if (this.webgl?.addon === addon) this.detachWebgl();
    });
    const renderService = (this.terminal as unknown as {
      _core: { _renderService: { _renderer: { value: { renderRows(start: number, end: number): void } } } };
    })._core._renderService;
    const paintOnResize = this.terminal.onResize(({ rows }) => renderService._renderer.value.renderRows(0, rows - 1));
    this.webgl = { addon, paintOnResize };
    this.webglView = view;
    webglHolders.push(this);
    // 超出个数就让最久没露面的那个退回 DOM;先挑藏着的,全都露着(很多扇窗)才轮到露着的。
    while (webglHolders.length > WEBGL_HOT_TERMINALS) {
      (webglHolders.find((pty) => !pty.shown && pty !== this) ?? webglHolders[0]).detachWebgl();
    }
  }

  private detachWebgl(): void {
    const held = webglHolders.indexOf(this);
    if (held !== -1) webglHolders.splice(held, 1);
    this.webgl?.paintOnResize.dispose();
    this.webgl?.addon.dispose();
    this.webgl = null;
    this.webglView = null;
  }

  private cancelReveal(): void {
    this.revealOnRender?.dispose();
    this.revealOnRender = null;
    this.ownedContainer.style.opacity = '';
  }

  /**
   * Move ownedContainer back to the off-screen host (tab deactivated /
   * TerminalPane unmounting).  Must be called after all ResizeObservers on
   * the visible mount target have been disconnected.
   */
  unmount(): void {
    this.cancelReveal();
    this.mounted = false;
    this.detachWebgl();
    ensureXtermHost().appendChild(this.ownedContainer);
    // 回到主窗的离屏宿主:它原来所在的那扇窗可能马上就关了,xterm 要改认主窗。
    this.terminal.open(this.ownedContainer);
  }

  /**
   * Permanently dispose this session (terminal or conversation deleted).
   * Unsubscribes from the main process, tears down the IPC data listener,
   * disposes the xterm Terminal, and removes the owned container from the DOM.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelRepaintFrame();
    this.cancelReveal();
    this.detachWebgl();
    FrontendPty.all.delete(this);
    FrontendPty.byPtySession.delete(this.ptySessionId);
    this.offData?.();
    this.offData = null;
    this.pendingLiveData = [];
    this.replayingHistory = false;
    this.inputHandler = null;
    this.inputDisposable.dispose();
    this.compositionFit.dispose();
    rpc.pty.unsubscribe(this.ptySessionId).catch(() => {});
    try {
      this.terminal.dispose();
    } catch {}
    try {
      this.ownedContainer.remove();
    } catch {}
  }
}

// ── Session lookup ────────────────────────────────────────────────────────────

/** Returns the live FrontendPty for the given session ID, or undefined if not yet connected. */
export function getFrontendPty(ptySessionId: string): FrontendPty | undefined {
  return FrontendPty.byPtySession.get(ptySessionId);
}

// ── App-wide helpers ──────────────────────────────────────────────────────────

/** Apply a theme to all live terminals. Called on app-level theme change. */
export function applyThemeToAll(theme?: SessionTheme): void {
  for (const pty of FrontendPty.all) {
    if (theme) {
      pty.setTheme(theme);
    } else {
      pty.refreshTheme();
    }
  }
}

/** Dispose all live FrontendPty instances. Called on app teardown. */
export function disposeAllPtys(): void {
  for (const pty of [...FrontendPty.all]) {
    pty.dispose();
  }
}
