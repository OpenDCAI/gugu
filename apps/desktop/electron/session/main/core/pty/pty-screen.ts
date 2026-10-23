import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import { log } from '@main/lib/logger';
import type { PtyDimensions } from './pty';

/**
 * @@@pty-screen — 一条 PTY 在主进程里的那块屏幕:后来才接上的读者(渲染层的终端视图、#6264 server 上的终端直连)
 * 拿到的是**此刻的屏幕 + 终端模式**,❌ 一段原始字节的尾巴。
 *
 * 为什么不能回放字节尾巴:全屏 TUI 只在启动时说一次「进备用屏」(`ESC[?1049h`)、开括号粘贴、开焦点上报,
 * 之后几个小时都只发差量重画。从前主进程留最后 64KB 原始输出,视图建得晚(会话先在后台跑、之后才点开)时
 * 回放里早没有那几句 ⇒ xterm 停在普通缓冲区,TUI 却以为自己在备用屏上画:画面是一帧过期的半成品;
 * 每改一次宽度,普通缓冲区按新宽度重排,把旧帧的顶部挤进回滚区 —— 屏上叠出一份份旧帧,owner 看到的
 * 「顶上一条冻住、收侧边栏往下复制、最后整屏冻住」(2026-10-05,Windows 与 macOS 同一机制)。
 *
 * 做法与 VS Code 重连终端相同:主进程用同一个 xterm(headless 版)解析同一串字节,接上时由 SerializeAddon
 * 序列化成「画出这块屏幕并恢复各模式」的字节。xterm 的 unicode 宽度表两边都用缺省(v6);渲染层若改用别的表,这里要一起改。
 * 不恢复的:G0/G1 字符集指定(现代 TUI 画框用 Unicode,不长期停在 DEC 线条字符集里)。
 */

/**
 * agent 屏幕快照的缺省回滚;普通终端由 LocalTerminalProvider 传入与前端一致的一万行,供关闭视图后重建。
 * 回滚越长,主进程每条写满的终端多占一份(每行 = 列数 × 12 字节)。全屏 TUI 在备用屏里,这一项与它无关。
 */
export const SCREEN_SCROLLBACK_LINES = 1_000;

/**
 * 切快照时,解析多久毫无进展就算停了。正常是毫秒级(要等的只是已经到了、还没解析完的输出);积压大时只要还在往前解析
 * 就接着等。毫无进展说明这块屏幕的解析停了(xterm 的解析器在发布产物里抛过,抛一次写入循环就再也不走,#4904)。
 * spec task-renderer:回放解析必须有界等待,停了就记录、照常接上实时输出,❌ 让终端卡在连接中或全黑。
 */
export const SNAPSHOT_STALL_MS = 10_000;

/** 跨批次记着的「还没收尾的那个转义序列」最多这么长;更长的(超大的 OSC 52 剪贴板)接不上就算了。 */
const MAX_CARRY = 64 * 1024;

/** SerializeAddon 不序列化鼠标坐标编码(`modes` 里没有这一项);从 xterm 自己的状态读出来补上。 */
const MOUSE_ENCODING_SEQUENCE: Record<string, string> = {
  DEFAULT: '',
  SGR: '\x1b[?1006h',
  SGR_PIXELS: '\x1b[?1016h',
};

/** DECSCUSR:光标形状 × 是否闪 → `CSI Ps SP q` 的 Ps。 */
const CURSOR_STYLE_PARAM: Record<string, [blinking: number, steady: number]> = {
  block: [1, 2],
  underline: [3, 4],
  bar: [5, 6],
};

type XtermCore = {
  coreMouseService: { activeEncoding: string };
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean; origin: boolean } };
  buffer: { x: number; y: number; scrollTop: number; scrollBottom: number };
  _inputHandler: { _parser: { currentState: number } };
};

export interface PtyScreenSnapshot {
  /** 画出这块屏幕、恢复各模式的字节;是旧画面,读者回放它时不该应答其中任何查询。 */
  data: string;
  /** 要快照之后、切出来之前到的输出,原样;是新输出,读者照实时输出处理(其中的查询要应答)。 */
  live: string;
  /** 快照按这个网格画出;读者先把自己的网格改成它再写入。 */
  size: PtyDimensions;
}

type PendingSnapshot = { tail: string[]; settle: (data: string) => void };

export class PtyScreen {
  private readonly terminal: Terminal;
  private readonly core: XtermCore;
  private readonly serializer = new SerializeAddon();
  /** 已经要了、还没切出来的快照:各自收着记号之后才写进来的批次(见 snapshot)。 */
  private readonly pending = new Set<PendingSnapshot>();
  /** 写进来的字节从最后一个 ESC 起到末尾:快照切在序列中间时,接上这一截才不会把后半截当成字。 */
  private sinceLastEsc = '';
  /** dispose 时的网格;非空 = 不再收输出、不再接新的快照请求,终端等已排着的快照切完再拆。 */
  private closedSize: PtyDimensions | null = null;
  /** 解析停了(切快照时毫无进展 / 序列化抛错):之后不再喂它,快照交空屏。 */
  private stalled = false;
  /** 已解析完的字节数(每批写入的回调里加):判「解析还在走」用。 */
  private parsedBytes = 0;

  constructor(
    size: PtyDimensions,
    private readonly stallMs = SNAPSHOT_STALL_MS,
    private readonly scrollback = SCREEN_SCROLLBACK_LINES,
  ) {
    this.terminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer);
    // xterm.js 6.0 的 DECRQM(`CSI ? Ps $ p`)在发布产物里抛 ReferenceError(#4904),抛在解析里 ⇒ 写入循环就此停住。
    // 渲染层在 pty.ts 绕过同一处;这里只吞掉,❌ 应答 —— 应答是看得见终端的那个视图的事。
    this.terminal.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true);
    this.terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true);
    // 鼠标编码、光标、滚动区域与解析器状态读的是 xterm 内部(SerializeAddon 自己也读内部的 _curAttrData)。
    // 升级 xterm 后形状变了就在这里响亮地坏,❌ 静默少恢复几个模式。
    const core = (this.terminal as unknown as { _core?: Partial<XtermCore> })._core;
    if (
      typeof core?.coreMouseService?.activeEncoding !== 'string' ||
      typeof core?.coreService?.isCursorHidden !== 'boolean' ||
      typeof core?.coreService?.decPrivateModes?.origin !== 'boolean' ||
      typeof core?.buffer?.scrollTop !== 'number' ||
      typeof core?._inputHandler?._parser?.currentState !== 'number'
    ) {
      throw new Error('PtyScreen: xterm internals changed (mouse encoding / cursor / scroll region / parser state)');
    }
    this.core = core as XtermCore;
  }

  private get closed(): boolean {
    return this.closedSize !== null;
  }

  /** PTY 的一批输出,按到达顺序。 */
  write(data: string): void {
    if (this.closed || !data) return;
    for (const snapshot of this.pending) snapshot.tail.push(data);
    if (this.stalled) return;
    this.terminal.write(data, () => {
      this.parsedBytes += data.length;
    });
    const esc = data.lastIndexOf('\x1b');
    const carry = esc >= 0 ? data.slice(esc) : this.sinceLastEsc + data;
    this.sinceLastEsc = carry.length > MAX_CARRY ? '' : carry;
  }

  /** 与数据同序:排在之前到的输出后面再改网格,那些字节是按旧网格画的。 */
  resize(cols: number, rows: number): void {
    if (this.closed || this.stalled) return;
    this.terminal.write('', () => this.terminal.resize(cols, rows));
  }

  /**
   * 此刻为止写进来的全部输出所画成的屏幕。xterm 的解析是异步的,所以排一个空写入当记号:
   * 记号解析完的那一刻,屏幕恰好反映记号之前的全部字节;记号之后才写进来的批次还没解析,原样放进 `live`。
   * ⇒ 调用之后写进来的每一批,要么在 `live` 里,要么由调用方从实时输出拿到 —— 交接靠调用方在调用的同一个同步片里挂上读者。
   * 切点落在一个转义序列中间时(PTY 一次读到半个序列),把这个序列已到的前半截接在屏幕后面,后半截在 `live` 或下一批里。
   * 从不 reject:解析停了或序列化抛错都记 error、交空屏(spec task-renderer:回放有界、照常接上实时输出)。
   */
  snapshot(): Promise<PtyScreenSnapshot> {
    if (this.closedSize) return Promise.resolve({ data: '', live: '', size: this.closedSize });
    if (this.stalled) return Promise.resolve({ data: '', live: '', size: this.size() });
    return new Promise((resolve) => {
      const carry = this.sinceLastEsc;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending: PendingSnapshot = {
        tail: [],
        settle: (data) => {
          clearTimeout(timer);
          if (!this.pending.delete(pending)) return;
          resolve({ data, live: pending.tail.join(''), size: this.size() });
        },
      };
      const settle = pending.settle;
      this.pending.add(pending);
      // 积压大时解析还在往前走就接着等;一整个窗口毫无进展才算停了。
      let seen = this.parsedBytes;
      const watch = () => {
        timer = setTimeout(() => {
          if (!this.pending.has(pending)) return;
          if (this.parsedBytes !== seen) {
            seen = this.parsedBytes;
            watch();
            return;
          }
          this.stall(`snapshot: parser made no progress for ${this.stallMs}ms`);
        }, this.stallMs);
        timer.unref?.();
      };
      watch();
      this.terminal.write('', () => {
        // 在 xterm 的写入回调里:抛出去会打断它的写入循环,所以就地接住。
        let data = '';
        try {
          data = this.serialize() + (this.core._inputHandler._parser.currentState === 0 ? '' : carry);
        } catch (error) {
          this.stall(`serialize failed: ${String(error)}`);
        }
        settle(data);
      });
    });
  }

  /**
   * 这一代 PTY 结束了(换代 / 注销)。已经要了的快照照常切完 —— 拆终端的记号排在它们后面 ——
   * 退出前最后那几批输出因此还在快照里。
   */
  dispose(): void {
    if (this.closed) return;
    this.closedSize = this.size();
    this.terminal.write('', () => this.terminal.dispose());
  }

  /** 这块屏幕不再可信:记 error;所有还在等的快照当场交空屏(连同各自已收的 live),之后的也是。 */
  private stall(reason: string): void {
    if (this.stalled) return;
    this.stalled = true;
    log.error('PtyScreen: screen stopped; late views get an empty screen plus live output', { reason });
    for (const pending of [...this.pending]) pending.settle('');
  }

  private size(): PtyDimensions {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /**
   * 已知的一瞬:备用屏缩窄之后、TUI 按新宽度重画之前,xterm 让每行保留旧宽度(再变宽时还原;画只画到 cols),
   * SerializeAddon 却按行长输出 ⇒ 恰好在这一瞬切的快照,超出列数的字会折到下一行。全屏 TUI 收到 SIGWINCH 就清屏重画
   * (Claude Code 实测每次改尺寸都 `ESC[2J`,清屏时底色是缺省,超出的格子随之清空、不再输出),
   * 紧跟在快照后面的实时输出把它盖掉。上游 0.15 beta 仍是同一写法。
   */
  private serialize(): string {
    let data = this.serializer.serialize({ scrollback: this.scrollback });
    const { coreMouseService, coreService, buffer } = this.core;
    const encoding = MOUSE_ENCODING_SEQUENCE[coreMouseService.activeEncoding];
    if (encoding === undefined) throw new Error(`PtyScreen: unknown xterm mouse encoding ${coreMouseService.activeEncoding}`);
    data += encoding;
    if (coreService.isCursorHidden) data += '\x1b[?25l';
    // 滚动区域(DECSTBM):TUI 设一次、之后靠 LF / RI 在区域里滚。设它会把光标归位,随即按原位置放回
    // (SerializeAddon 已在前面恢复了原点模式 DECOM;开着时行号相对区域顶)。
    if (buffer.scrollTop !== 0 || buffer.scrollBottom !== this.terminal.rows - 1) {
      const row = coreService.decPrivateModes.origin ? buffer.y - buffer.scrollTop : buffer.y;
      data += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r\x1b[${row + 1};${Math.min(buffer.x, this.terminal.cols - 1) + 1}H`;
    }
    const cursorStyle = coreService.decPrivateModes.cursorStyle;
    if (cursorStyle !== undefined) {
      const param = CURSOR_STYLE_PARAM[cursorStyle];
      if (!param) throw new Error(`PtyScreen: unknown xterm cursor style ${cursorStyle}`);
      data += `\x1b[${coreService.decPrivateModes.cursorBlink === false ? param[1] : param[0]} q`;
    }
    return data;
  }
}
