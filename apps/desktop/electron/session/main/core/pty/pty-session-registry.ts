import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { ptyDataChannel, ptyExitChannel, ptyInputChannel } from '@shared/core/pty/ptyEvents';
import { ptyStartedChannel } from '@shared/events/appEvents';
import type { Pty, PtyDimensions, PtyExitInfo } from './pty';
import { forgetPtyOutput, recordPtyOutput } from './pty-output-activity';
import { PtyScreen, type PtyScreenSnapshot } from './pty-screen';
import { forgetTerminalInputSession } from './terminal-input';
import { createProviderBlockerDetector, createProviderReviewGateDetector } from '@main/core/sessions/provider-review-gate';
import type { ProviderBlocker, ProviderReviewGate } from '@shared/core/sessions/sessionEvents';

export interface PtySessionMetadata {
  providerId?: AgentProviderId;
  title?: string;
  /**
   * 这一发新起了 agent 进程的时刻。接回一个早已在跑的 tmux 会话时不填 —— 那个进程何时起的这边不知道,
   * 它屏幕上的东西(比如提问选择器)都还在。
   */
  agentStartedAt?: number;
}

/**
 * @@@leading-edge-flush — 空闲后到的第一块立刻发,之后每 16ms(一帧)发一次这一拍攒下的;某一拍没攒到东西就停,
 * 下一块又是立刻发。按键回显因此不必等满一拍(2026-10-19 macOS 实测从前每次回显都多 16.8ms),
 * 流式输出照旧一帧一批。
 *
 * @@@frame-open — 只有一帧画完了才当场发。TUI 画一帧时要么包在同步输出块里(DEC 2026),要么先藏光标、画完再显示
 * (`?25l … ?25h`);攒下的数据停在一帧中间(块开着没关,或这一批里藏了光标还没显示)就先不发,收尾的那一块一到
 * 当场发,最晚到这一拍结束照发(等待上限仍是 16ms)。不然中间态会被画出来、helper textarea(输入法的锚点)
 * 被带到光标半路停的地方:Windows 上 psmux 把每一帧拆成「藏光标 + 画状态栏」和「光标移回输入框 + 显示」两块、
 * 相隔约 15ms 送来,且不发 2026(Chole 实测 88 帧拆了 86 帧),Claude Code 一转圈光标和输入法就跳。
 * 光标只看这一批里有没有藏:一直藏着光标的程序(全屏 TUI)不因此每次都被扣住。读块可能把一个序列截成两半
 * (`…\x1b[?25` | `l…`),截下的前半截接到下一块前面一起认。
 */
const FLUSH_INTERVAL_MS = 16;
const FRAME_TOGGLE = /\x1b\[\?(2026|25)([hl])/g;
/** 一块末尾若是这两种序列之一的前半截(还差最后一个字母),返回它,接到下一块前面。 */
function trailingTogglePrefix(text: string): string {
  const esc = text.lastIndexOf('\x1b');
  if (esc === -1) return '';
  const tail = text.slice(esc);
  return '\x1b[?2026'.startsWith(tail) || '\x1b[?25'.startsWith(tail) ? tail : '';
}

export class PtySessionRegistry {
  private ptyMap: Map<string, Pty> = new Map();
  private ptyInputSubscriptions: Map<string, () => void> = new Map();
  /** 每条会话的屏幕;`preserveBufferOnExit` 的会话退出后留着,供之后才打开的视图看到最后的样子。 */
  private screens: Map<string, PtyScreen> = new Map();
  private activeConsumers: Set<string> = new Set();
  private metadata: Map<string, PtySessionMetadata> = new Map();
  private lastSizes: Map<string, { cols: number; rows: number }> = new Map();
  private pendingFlushes: Map<string, () => void> = new Map();

  register(
    ptySessionId: string,
    pty: Pty,
    options: {
      /** PTY 起的网格:屏幕从第一个字节起就要按 PTY 自己的网格解析。 */
      size: PtyDimensions;
      preserveBufferOnExit?: boolean;
      metadata?: PtySessionMetadata;
      onProviderReviewGate?: (gate: ProviderReviewGate) => void;
      onProviderBlocker?: (blocker: ProviderBlocker) => void;
    }
  ): void {
    const preserveBufferOnExit = options.preserveBufferOnExit ?? false;

    // Clear the screen and consumer of a previous PTY at this ptySessionId (respawn)
    this.ptyInputSubscriptions.get(ptySessionId)?.();
    this.ptyInputSubscriptions.delete(ptySessionId);
    this.pendingFlushes.delete(ptySessionId);
    this.disposeScreen(ptySessionId);
    this.activeConsumers.delete(ptySessionId);
    this.metadata.delete(ptySessionId);
    if (options.metadata) this.metadata.set(ptySessionId, options.metadata);

    this.ptyMap.set(ptySessionId, pty);
    const screen = new PtyScreen(options.size);
    this.screens.set(ptySessionId, screen);

    // Adopt the grid the renderer already asked for.  Spawn callers size the PTY
    // from `getLastSize()` before a long async prelude, so a resize broadcast
    // during that window — or in the gap between spawning and registering — is
    // only visible here.  Replaying it now costs one ioctl and lands before the
    // child has drawn its first frame; without it the session stays at the
    // 80x24 spawn default until something else changes the pane's size.
    const desiredSize = this.lastSizes.get(ptySessionId);
    if (desiredSize) {
      pty.resize(desiredSize.cols, desiredSize.rows);
      screen.resize(desiredSize.cols, desiredSize.rows);
    }

    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** 同步输出块开着没关 / 这一批里藏了光标还没显示(@@@frame-open);held = 这一拍是因为帧没收尾才没当场发的。 */
    const frame = { sync: false, hidden: false, held: false, carry: '' };
    const detectProviderReviewGate = options.onProviderReviewGate
      ? createProviderReviewGateDetector(options.onProviderReviewGate)
      : null;
    const detectProviderBlocker = options.onProviderBlocker
      ? createProviderBlockerDetector(options.onProviderBlocker, options.metadata?.providerId)
      : null;

    const flush = () => {
      // 也会被提前调用(resize 之前、退出 / 注销时):那一拍排着的定时器就不必再来。
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (this.ptyMap.get(ptySessionId) !== pty) {
        buffer = '';
        flushTimer = null;
        return;
      }
      frame.hidden = false;
      frame.held = false;
      if (buffer) {
        const batch = buffer;
        buffer = '';
        // 屏幕与读者收的是同一批、同一个时刻:快照与实时输出的交界就落在批与批之间(见 PtyScreen.snapshot)。
        // 屏幕也是一个读者:它出错(xterm 积压过 50MB 会抛)不许打断下面的投递。400MB 刷屏实测没积压到那里 ——
        // 解析与读 PTY 在同一个事件循环上,解析忙时 PTY 读得慢,写的那一端随之被内核挡住。
        try {
          screen.write(batch);
        } catch (error) {
          log.warn('PtySessionRegistry: screen write failed', { ptySessionId, error: String(error) });
        }
        events.emit(ptyDataChannel, batch, ptySessionId);
      }
      flushTimer = null;
    };
    this.pendingFlushes.set(ptySessionId, flush);
    const flushEachFrame = () => {
      flushTimer = null;
      if (!buffer) return;
      flush();
      flushTimer = setTimeout(flushEachFrame, FLUSH_INTERVAL_MS);
    };

    pty.onData((data) => {
      // @@@pty-output-activity(#5558) 这一行是「出过字没有 / 最后一个字节何时」的**唯一**写入处。
      // 记在 `ptyMap` 那道守卫**之前**:它记的是这条 PTY 的事实,与它此刻还是不是本 sessionId 的
      // 当班者无关(键是 pty 对象本身,换代不会串台)。读者见 keystroke-injection.ts 的就绪闸。
      recordPtyOutput(pty);
      if (this.ptyMap.get(ptySessionId) !== pty) return;
      detectProviderReviewGate?.(data);
      detectProviderBlocker?.(data);
      buffer += data;
      const scanned = frame.carry + data;
      for (const [, mode, set] of scanned.matchAll(FRAME_TOGGLE)) {
        if (mode === '2026') frame.sync = set === 'h';
        else frame.hidden = set === 'l';
      }
      frame.carry = trailingTogglePrefix(scanned);
      const open = frame.sync || frame.hidden;
      if (flushTimer) {
        if (frame.held && !open) {
          flush();
          flushTimer = setTimeout(flushEachFrame, FLUSH_INTERVAL_MS);
        }
        return;
      }
      if (open) frame.held = true;
      else flush();
      flushTimer = setTimeout(flushEachFrame, FLUSH_INTERVAL_MS);
    });

    pty.onExit((info) => {
      // @@@pty-output-activity(#5558) 流结束了,那条「出过字/最后一个字节何时」的事实随之作废 ——
      // 否则一条已死的 PTY 仍会被读成「启动期已过、可以直接写」。在 isCurrentPty 那道守卫**之前**清:
      // 换代之后老对象也该忘掉自己的活动记录。
      forgetPtyOutput(pty);
      const isCurrentPty = this.ptyMap.get(ptySessionId) === pty;
      if (!isCurrentPty) return;

      // Flush any buffered output before emitting exit
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flush();
      }
      events.emit(ptyExitChannel, info, ptySessionId);
      if (preserveBufferOnExit) {
        // Partial cleanup: keep the screen so late-connecting renderers still see the final output
        this.ptyMap.delete(ptySessionId);
        this.ptyInputSubscriptions.get(ptySessionId)?.();
        this.ptyInputSubscriptions.delete(ptySessionId);
        this.pendingFlushes.delete(ptySessionId);
        this.lastSizes.delete(ptySessionId);
      } else {
        this.unregister(ptySessionId);
      }
    });

    const off = events.on(
      ptyInputChannel,
      (data) => {
        pty.write(data);
      },
      ptySessionId
    );

    this.ptyInputSubscriptions.set(ptySessionId, off);
    events.emit(ptyStartedChannel, { id: ptySessionId });
  }

  unregister(ptySessionId: string, options: { pty?: Pty; exitInfo?: PtyExitInfo } = {}): void {
    if (options.pty !== undefined && this.ptyMap.get(ptySessionId) !== options.pty) return;
    this.pendingFlushes.get(ptySessionId)?.();
    if (options.exitInfo !== undefined) {
      const exitInfo = options.exitInfo;
      events.emit(ptyExitChannel, exitInfo, ptySessionId);
    }
    this.ptyMap.delete(ptySessionId);
    this.ptyInputSubscriptions.get(ptySessionId)?.();
    this.ptyInputSubscriptions.delete(ptySessionId);
    this.pendingFlushes.delete(ptySessionId);
    this.disposeScreen(ptySessionId);
    this.activeConsumers.delete(ptySessionId);
    this.metadata.delete(ptySessionId);
    this.lastSizes.delete(ptySessionId);
    forgetTerminalInputSession(ptySessionId);
  }

  get(ptySessionId: string): Pty | undefined {
    return this.ptyMap.get(ptySessionId);
  }

  /**
   * 这条会话此刻那块屏幕的快照。等的时候换了代(agent 重启,同一个 id 重新登记了另一块屏幕)⇒ 改切新那块:新屏幕从
   * 新一代的第一个字节起就在,它的快照涵盖新一代已经到的全部输出,一字不漏。等的时候注销了 ⇒ 交已切到的这份
   * (退出前最后那几句在里面)。一开始就没有屏幕(还没起 PTY / 已注销)⇒ null。
   */
  private async currentSnapshot(ptySessionId: string): Promise<PtyScreenSnapshot | null> {
    for (;;) {
      const screen = this.screens.get(ptySessionId);
      if (!screen) return null;
      const snapshot = await screen.snapshot();
      const now = this.screens.get(ptySessionId);
      if (now === screen || now === undefined) return snapshot;
    }
  }

  /**
   * 渲染层接上一条会话:`buffer` = 此刻的屏幕快照(见 pty-screen.ts,旧画面,回放时不应答其中的查询),
   * `live` = 要快照之后、切出来之前到的输出(新输出,照实时处理),`size` = 快照的网格。
   *
   * 交接不漏不重:那几批同时照常经 `ptyDataChannel` 发出,而终端视图要等这次调用返回后才挂上监听,收不到它们,
   * 只从 `live` 拿。快照切出来之后的批次要等之后的 PTY 读取或定时器才发,晚于这次调用的应答 —— 与从前同步返回原始字节缓冲时
   * 是同一个前提。没有屏幕 ⇒ 空快照,网格是渲染层最后要过的那个。
   */
  async subscribe(ptySessionId: string): Promise<{ buffer: string; live: string; size: PtyDimensions | null }> {
    this.activeConsumers.add(ptySessionId);
    const snapshot = await this.currentSnapshot(ptySessionId);
    if (!snapshot) return { buffer: '', live: '', size: this.lastSizes.get(ptySessionId) ?? null };
    return { buffer: snapshot.data, live: snapshot.live, size: snapshot.size };
  }

  private disposeScreen(ptySessionId: string): void {
    this.screens.get(ptySessionId)?.dispose();
    this.screens.delete(ptySessionId);
  }

  /**
   * Remove the consumer registration for a session.
   * Called when the renderer disposes its FrontendPty.
   */
  unsubscribe(ptySessionId: string): void {
    this.activeConsumers.delete(ptySessionId);
  }

  getMetadata(ptySessionId: string): PtySessionMetadata | undefined {
    return this.metadata.get(ptySessionId);
  }

  /**
   * Apply the renderer's measured grid to a session.
   *
   * The size is recorded even when no PTY is registered yet.  Spawning a
   * conversation is asynchronous (workspace trust, hook install, executable
   * resolution) while the renderer measures its pane and broadcasts the real
   * cols/rows as soon as the terminal mounts — so the very first resize of a
   * freshly hydrated session routinely lands *before* `register()`.  Dropping
   * it left the child running at the 80x24 spawn default forever: the xterm
   * grid was the full pane while the TUI kept wrapping at column 80, which is
   * the large blank region on the right and below the output.  Nothing
   * re-sends, because the pane's pixel dimensions never change again.
   *
   * Recording it makes the size survive the race: `register()` applies it to
   * the incoming PTY, and spawn paths that consult `getLastSize()` can start
   * the child at the right size instead of resizing it after the first paint.
   * The entry has the same lifetime as the session's own — `unregister()`
   * clears it.
   *
   * Returns false when there was no PTY to resize, so the RPC layer still
   * reports `not_found` to the caller.
   */
  resize(ptySessionId: string, cols: number, rows: number): boolean {
    const last = this.lastSizes.get(ptySessionId);
    this.lastSizes.set(ptySessionId, { cols, rows });
    const pty = this.ptyMap.get(ptySessionId);
    if (!pty) return false;
    // Every resize path (this desktop's panes, an attached desktop, a restart re-send) lands here, so this
    // is where an unchanged size stops: the TUI repaints its whole screen on each resize it receives.
    if (last?.cols === cols && last.rows === rows) return true;
    // 还攒着没刷的那批是按旧网格画的:先刷进屏幕,再让屏幕改网格。
    this.pendingFlushes.get(ptySessionId)?.();
    pty.resize(cols, rows);
    this.screens.get(ptySessionId)?.resize(cols, rows);
    return true;
  }

  getLastSize(ptySessionId: string): { cols: number; rows: number } | undefined {
    return this.lastSizes.get(ptySessionId);
  }

  /** Active PTYs with local OS PID; SSH entries have `pid: undefined`. */
  listActiveSessions(): Array<{
    ptySessionId: string;
    pid: number | undefined;
    metadata?: PtySessionMetadata;
  }> {
    const out: Array<{
      ptySessionId: string;
      pid: number | undefined;
      metadata?: PtySessionMetadata;
    }> = [];
    for (const [ptySessionId, pty] of this.ptyMap) {
      out.push({
        ptySessionId,
        pid: pty.getPid?.(),
        metadata: this.metadata.get(ptySessionId),
      });
    }
    return out;
  }
}

export const ptySessionRegistry = new PtySessionRegistry();
