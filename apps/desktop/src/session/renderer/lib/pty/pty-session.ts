import { makeAutoObservable, onBecomeObserved, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { FrontendPty, loadXterm } from '@renderer/lib/pty/pty';
import { ptyStartedChannel } from '@shared/events/appEvents';

export type PtySessionStatus = 'disconnected' | 'connecting' | 'ready';

export type PtySessionOptions = {
  clearOnBackendStart?: boolean;
};

type PtySessionPrepareResult = void | false;

export class PtySession {
  pty: FrontendPty | null = null;
  status: PtySessionStatus = 'disconnected';
  /**
   * 终端里已经有内容了吗。
   * `status === 'ready'` 只说明管道通了，不说明有东西可看 —— agent 起来之前终端是
   * 一片空白 + 一个闪烁光标。加载态要看这个信号才撤，否则等待的后半段是裸的。
   */
  hasOutput = false;
  private connectPromise: Promise<void> | null = null;
  private version = 0;
  private hasSeenBackendStart = false;
  private offPtyStarted: (() => void) | null = null;
  private readonly clearOnBackendStart: boolean;

  constructor(
    readonly ptySessionId: string,
    private readonly prepare?: () => Promise<PtySessionPrepareResult>,
    private readonly onOpenFile?: (filePath: string) => void,
    private readonly onOpenExternal?: (filePath: string) => void,
    options: PtySessionOptions = {}
  ) {
    this.clearOnBackendStart = options.clearOnBackendStart ?? false;
    makeAutoObservable(this, {
      pty: false,
    });
    this.offPtyStarted = events.on(ptyStartedChannel, (event) => {
      if (event.id !== this.ptySessionId) return;
      this.handleBackendStarted();
    });
    // Lazy connect: auto-connects the first time any observer reads status.
    // Sessions are created at data-load time without connecting; this fires
    // when the session is first rendered as the active conversation or terminal.
    onBecomeObserved(this, 'status', () => {
      if (this.status === 'disconnected') void this.connect();
    });
  }

  async connect() {
    if (this.pty) return;
    if (this.connectPromise) return this.connectPromise;

    const version = this.version;
    this.connectPromise = (async () => {
      const prepared = await this.prepare?.();
      if (prepared === false) return;
      await loadXterm();
      if (version !== this.version) return;
      if (this.pty) return;
      const pty = new FrontendPty(this.ptySessionId, undefined, this.onOpenFile, this.onOpenExternal);
      pty.onFirstOutput = () => {
        if (this.pty !== pty) return;
        runInAction(() => {
          this.hasOutput = true;
        });
      };
      runInAction(() => {
        this.pty = pty;
        this.status = 'connecting';
      });
      await pty.connect();
      if (version !== this.version || this.pty !== pty) return;
      this.hasSeenBackendStart = true;
      runInAction(() => {
        this.status = 'ready';
      });
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  dispose() {
    this.version++;
    this.pty?.dispose();
    this.hasSeenBackendStart = false;
    runInAction(() => {
      this.pty = null;
      this.hasOutput = false;
      this.status = 'disconnected';
    });
  }

  destroy() {
    this.dispose();
    this.offPtyStarted?.();
    this.offPtyStarted = null;
  }

  private handleBackendStarted(): void {
    if (this.status !== 'ready') return;

    if (!this.hasSeenBackendStart) {
      this.hasSeenBackendStart = true;
      return;
    }

    if (this.clearOnBackendStart) this.pty?.clear();
    // 同一个 pty id 上换了一条新进程(重启本会话 / 换模型 / 凭据恢复)。宿主停旧进程时把这个 id 记着的
    // 尺寸一并清了(pty-session-registry 的 unregister),新进程于是按 spawn 默认尺寸起;而窗格的像素尺寸
    // 没变,resize 控制器不会再发 —— TUI 就一直按窄的那一版折行,右边空一大块。
    // ⇒ 前端的网格就是这个终端当下的真实尺寸,新进程一到就把它补过去。
    const terminal = this.pty?.terminal;
    if (terminal) void rpc.pty.resize(this.ptySessionId, terminal.cols, terminal.rows);
  }
}
