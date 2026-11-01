import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { onErrorEvent, onErrorEvents } from '@gugu/session-shared';
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec';
import {
  reapEngineTree,
  signalEngineTree,
  defaultEngineTreeOps,
  type AcpFs,
  type AcpProcessHandle,
  type AcpTerminalExit,
  type AcpTerminalProcess,
} from '@gugu/session-core/acp/node';
import type { AcpRuntimeProcessHost } from '../runtime/types';

class ChildProcessHandle implements AcpProcessHandle {
  private firstError: Error | null = null;
  private readonly errorSubscribers: ((err: Error) => void)[] = [];

  private readonly owned: OwnedChild;
  readonly child: ChildProcess;

  /** `spawn` 收这个 handle 的错误出口:子进程本体的 'error' 与停不下来的树都从那里进来。 */
  constructor(spawn: (onError: (err: Error) => void) => OwnedChild) {
    this.owned = spawn((err) => this.reportError(err));
    const child = (this.child = this.owned.child);
    // @@@unhandled-error-event (#4942) 四个**独立**发射器在构造这一刻全部挂上出口。
    // 此前只有 child 本体经 onError() 被接上,stdin / stdout / stderr 从来没有任何监听者 ——
    // teardown 期往已死子进程写 stdin 的 EPIPE 正是从那里出来的,而 Node 对没有监听者的 'error'
    // 一视同仁地抛成未捕获异常,在 Electron 主进程 / 会话页宿主里 == 整个宿主连同所有会话一起死。
    // 这类失败是**异步**的:它从发射器的 'error' 事件出来,不从 spawn() / write() 的返回值出来 ⇒
    // 调用点外面那圈 try/catch 一次也接不住,只能在事件这一侧接。
    // 挂在构造时而不是等 onError():订阅者隔着一个 await 才到。实测当前调用链来得及,但那是
    // **调用方**持有的时序不变量、不由这里保证 ⇒ 首错记下来由 onError() 补发(❌ 不是吞掉)。
    onErrorEvents([child.stdin, child.stdout, child.stderr], (err) => this.reportError(err));
  }

  /** 记下首错并广播;❌ 不是吞错 —— 后到的订阅者会被补发(见 onError)。 */
  private reportError(err: Error): void {
    if (!this.firstError) this.firstError = err;
    for (const cb of this.errorSubscribers) cb(err);
  }

  get stdin() {
    if (!this.child.stdin) throw new Error('ChildAcpProcessHost: child has no stdin');
    return this.child.stdin;
  }

  get stdout() {
    if (!this.child.stdout) throw new Error('ChildAcpProcessHost: child has no stdout');
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr ?? undefined;
  }

  get exitCode() {
    return this.child.exitCode;
  }

  /** 宿主实际从这个 child 的 stdout 读回复 ⇒ 它就是投递进程。 */
  get pid() {
    return this.child.pid ?? null;
  }

  onExit(cb: (exit: { code: number | null; signal: string | null }) => void): void {
    this.child.on('exit', (code, signal) => cb({ code, signal: signal ?? null }));
  }

  onError(cb: (err: Error) => void): void {
    this.errorSubscribers.push(cb);
    // @@@unhandled-error-event (#4942) 补发首错:出口挂在构造时、订阅隔着一个 await 才到,
    // 中间到达的错误若不补发,常驻出口就从「守住」变成「默默吃掉」。
    if (this.firstError) cb(this.firstError);
  }

  // @@@5405 杀**整组**而不是只杀直接子:这条路是两层 —— worker → 薄适配器 → 它自己 spawn 的引擎
  // (claude / codex app-server)。只杀直接子,引擎孙进程会 reparent 到 PID1 成孤儿。spawn 侧已经
  // 让适配器自成组长(见下),所以负 pid 就是这棵树的地址。
  kill(signal?: NodeJS.Signals): void {
    signalEngineTree(this.owned, signal ?? 'SIGTERM', defaultEngineTreeOps());
  }

  /** @@@5405 退出边上收树 —— 契约见 `AcpProcessHandle.reap`。 */
  reap(): Promise<{ reaped: number; pids: number[] }> {
    return reapEngineTree(this.child.pid).then(({ reaped, pids }) => ({ reaped, pids }));
  }
}

class ChildTerminalProcess extends EventEmitter implements AcpTerminalProcess {
  private _exitCode: number | null = null;
  private firstError: Error | null = null;

  private readonly owned: OwnedChild;
  readonly child: ChildProcess;

  constructor(spawn: (onError: (err: Error) => void) => OwnedChild) {
    super();
    this.owned = spawn((err) => this.emit('error', err));
    const child = (this.child = this.owned.child);
    child.on('exit', (code, signal) => {
      this._exitCode = code;
      this.emit('exit', { exitCode: code, signal: signal ?? null } satisfies AcpTerminalExit);
    });

    // @@@unhandled-error-event (#4942) 这行 `this.emit('error', ...)` 只是把致命性从 child 搬到了
    // 自己身上:转发出去的 'error' 若这一刻没有监听者,Node 照样抛成未捕获异常 —— 而这条链路上
    // **一个订阅者都没有**(ManagedAgentTerminal 此前只订阅 onExit),所以一个终端起不来就带走
    // 整个宿主。修法是两头都补:那边接上(见 managed-terminal.ts),这边先给自己挂常驻出口。
    // 这类失败是**异步**的 —— 从发射器的 'error' 事件出来,不从 spawn() 的返回值出来,
    // create() 调用点外面的 try/catch 一次也接不住。
    // 另外只挂 child 是不够的:stdout / stderr 是另外两个**独立**发射器,此前完全没人守。
    // 常驻出口记下首错、由 onError() 补发(❌ 不是吞掉):订阅者隔着一个 await 才到,实测来得及,
    // 但那是调用方持有的时序不变量,不该由这一层默认它永远成立。
    onErrorEvent(this, (err) => {
      if (!this.firstError) this.firstError = err;
    });
    onErrorEvents([child.stdout, child.stderr], (err) => this.emit('error', err));
  }

  get stdout() {
    if (!this.child.stdout) throw new Error('ChildTerminalProcess: child has no stdout');
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr ?? undefined;
  }

  get exitCode() {
    return this._exitCode;
  }

  onExit(cb: (status: AcpTerminalExit) => void): void {
    this.on('exit', cb);
  }

  onError(cb: (err: Error) => void): void {
    this.on('error', cb);
    // @@@unhandled-error-event (#4942) 订阅前已到达的错误要补发,否则常驻出口就成了吞错。
    if (this.firstError) cb(this.firstError);
  }

  kill(signal?: NodeJS.Signals): void {
    this.owned.kill(signal);
  }
}

const fsPort: AcpFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, content, encoding) => writeFile(path, content, encoding),
  mkdir: (path, opts) => mkdir(path, opts),
};

export class ChildAcpProcessHost implements AcpRuntimeProcessHost {
  readonly fs = fsPort;

  async spawn(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpProcessHandle> {
    const handle = new ChildProcessHandle((onError) =>
      spawnOwnedChild(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // @@@5405 POSIX 上自成进程组:child.pid 即组长 pid,这棵树从此有了一个**在组长死后仍然
        // 有效**的地址(父子链会被 SIGKILL 当场摧毁,进程组不会)。没有它,适配器与这个 worker
        // 同组 —— 那时 kill(-pid) 会把 worker 连同其它会话一起收掉,收树这条路根本不存在。
        // Windows 上 spawnOwnedChild 不把 detached 传下去(那里没有进程组,收树靠 taskkill /T)。
        detached: true,
        onError,
      })
    );
    if (!handle.child.stdin || !handle.child.stdout) {
      throw new Error('ChildAcpProcessHost: failed to spawn process - no stdio streams');
    }
    return handle;
  }

  async spawnTerminal(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpTerminalProcess> {
    const terminal = new ChildTerminalProcess((onError) =>
      spawnOwnedChild(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        onError,
      })
    );
    if (!terminal.child.stdout) {
      throw new Error('ChildAcpProcessHost: failed to spawn terminal - no stdout stream');
    }
    return terminal;
  }
}
