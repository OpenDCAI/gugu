import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from '@gugu/core/local/childProcess';
import { onErrorEvents, type IDisposable } from '@gugu/session-shared';
import type { BoundExec } from '../exec';

const REQUEST_TIMEOUT_MS = 5_000;

type Pending = {
  query: string;
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
};

export type CatFileBatchOptions = {
  exec: BoundExec;
};

export class CatFileBatch implements IDisposable {
  private readonly exec: BoundExec;
  private disposed = false;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private chunksLength = 0;
  private wake: (() => void) | null = null;
  private queue: Pending[] = [];
  private processing = false;
  private readAborted: Error | null = null;

  constructor(options: CatFileBatchOptions) {
    this.exec = options.exec;
  }

  readText(query: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('CatFileBatch disposed'));
        return;
      }
      this.queue.push({ query, resolve, reject });
      if (!this.processing) void this.next();
    });
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.chunks = [];
    this.chunksLength = 0;
    this.readAborted = new Error('CatFileBatch disposed');
    this.wake?.();
    this.wake = null;
    this.processing = false;
    const queue = this.queue;
    this.queue = [];
    for (const item of queue) {
      item.reject(this.readAborted);
    }
  }

  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error('CatFileBatch disposed');
    if (this.proc) return this.proc;

    this.readAborted = null;
    const child = spawn(this.exec.file, ['cat-file', '--batch'], {
      cwd: this.exec.cwd,
      env: this.exec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();

    child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.chunksLength += chunk.length;
      this.wake?.();
    });
    child.stdout.on('end', () => {
      this.readAborted = new Error('git cat-file stdout ended');
      this.wake?.();
    });
    child.on('error', () => {
      this.recordProcDeath(new Error('git cat-file process error'));
    });
    // @@@unhandled-error-event (#4942) — 三条 stdio 流是**独立于进程本体的发射器**:上面那行只接住了本体。
    // 这个类在超时(REQUEST_TIMEOUT_MS)、头部解析失败、以及 dispose() 里都会自己 kill 掉 git,而 next()
    // 随后仍可能往这条已死的管道 write() —— 那次写失败**不在调用点抛**,它异步地走 stdin 的 'error'
    // 事件。零监听者时 Node 把它抛成未捕获异常,在主进程里 = 整个咕咕连同所有会话一起死。
    // ❌ 不是吞错:错误照旧进 recordProcDeath,在途请求会被 readAborted 一并 reject(fail loud 不变)。
    onErrorEvents([child.stdin, child.stdout, child.stderr], (error) => {
      this.recordProcDeath(new Error(`git cat-file stdio error: ${error.message}`));
    });
    child.on('close', () => {
      this.recordProcDeath(new Error('git cat-file process exited'));
    });

    this.proc = child;
    return this.proc;
  }

  private async next(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const item = this.queue[0]!;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const proc = this.ensureProc();
      proc.stdin.write(`${item.query}\n`);

      timeoutId = setTimeout(() => {
        try {
          this.proc?.kill();
        } catch {}
      }, REQUEST_TIMEOUT_MS);

      const line = await this.readLine();
      clearTimeout(timeoutId);
      timeoutId = undefined;

      if (line.endsWith(' missing') || line === 'missing' || line.endsWith(' ambiguous')) {
        item.resolve(null);
      } else {
        const parts = line.split(' ');
        const size = Number.parseInt(parts[parts.length - 1] ?? '', 10);
        if (Number.isNaN(size)) {
          proc.kill();
          throw new Error(`Unexpected cat-file header: ${line}`);
        }
        const body = await this.readBytes(size + 1);
        item.resolve(body.subarray(0, -1).toString('utf8'));
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      item.reject(err);
      try {
        this.proc?.kill();
      } catch {}
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.queue.shift();
      void this.next();
    }
  }

  private recordProcDeath(error: Error): void {
    this.proc = null;
    this.readAborted = error;
    this.buffer = Buffer.alloc(0);
    this.chunks = [];
    this.chunksLength = 0;
    this.wake?.();
  }

  private consolidate(): void {
    if (this.chunks.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, ...this.chunks]);
    this.chunks = [];
    this.chunksLength = 0;
  }

  private waitForData(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private async readLine(): Promise<string> {
    for (;;) {
      if (this.readAborted) throw this.readAborted;
      let newline = this.buffer.indexOf(0x0a);
      if (newline === -1 && this.chunks.length > 0) {
        this.consolidate();
        newline = this.buffer.indexOf(0x0a);
      }
      if (newline !== -1) {
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      await this.waitForData();
    }
  }

  private async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length + this.chunksLength < count) {
      if (this.readAborted) throw this.readAborted;
      await this.waitForData();
    }
    this.consolidate();
    const output = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return output;
  }
}
