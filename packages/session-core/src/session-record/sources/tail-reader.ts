import { open, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import type { RecordSourceWarn } from './shared';

export type TailRestartReason = 'source_replaced' | 'source_unreadable';

/**
 * 一块读到的完整行。整份读会调多次 —— 见 `readFromStart` 的说明。
 * `offsets[i]` 是 `lines[i]` 第一个字节在文件里的位置(工具图按它记原文位置,见 `RecordImageRef`)。
 */
export type LineSink = (lines: string[], offsets: number[]) => void;

export type TailReaderEvents = {
  /** 新读到的**完整**行（不含结尾换行；末尾半行留在缓冲里等下一轮）。 */
  onLines(lines: string[], offsets: number[]): void;
  /** 文件被截断 / 换了 inode / 读不到了 —— 已读到的东西全部作废。 */
  onRestart(reason: TailRestartReason): void;
};

/**
 * 单文件尾读器：**轮询是主，fs.watch 是加速**。
 *
 * 为什么不能只挂 fs.watch：它在 overlayfs / 网络盘 / 某些容器 runtime 上会静默失效 ——
 * 不抛错、不报警，就是永远不来事件。那种失效在界面上表现为「这个会话不动了」，
 * 和 agent 真的没说话完全无法区分。所以可见延迟的上界由轮询给，watch 只负责把
 * 常见情况从"最多一个节拍"压到"几乎立刻"。
 */
/** 尾读器此刻的续读点：从这里接着读，读到的第一个字节就是某一行的开头。 */
export type TailResume = {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** 上一条完整行的换行符之后那个字节位置。❌ 不是 `offset` —— 那可能停在半个字符中间。 */
  readonly lineOffset: number;
};

export class TailReader {
  private offset = 0;
  /**
   * 最后一条**已交付**的行的换行符之后那个字节位置。
   *
   * `offset` 是「读到哪儿了」，按 256KB 一块推进，随时可能停在半个 UTF-8 字符中间；
   * 拿它当续读点，下次从那里开始解码就会在断点处生出替换字符。`lineOffset` 是
   * 「交付到哪儿了」，永远落在行边界上，才是能存下来、下次接着读的那个数。
   */
  private lineOffset = 0;
  private partial = '';
  /**
   * 按字节读、按字符切，中间必须过解码器。
   *
   * 读取窗口按字节切，一个 CJK 字符横跨两次 read 是常态；直接 `buffer.toString('utf8')`
   * 会在断点处各生成一个 U+FFFD，于是记录里凭空多出两个替换字符 —— 那不是显示瑕疵，
   * 是把用户说过的话改掉了。StringDecoder 把半个字符留到下一块。
   */
  private decoder = new StringDecoder('utf8');
  private ino: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  /** 正在跑的那一趟读。同一时刻只跑一趟;追到文件尾的人要等它跑完再读一趟。 */
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private missing = false;

  constructor(
    private path: string,
    private readonly pollIntervalMs: number,
    private readonly events: TailReaderEvents,
    private readonly warn: RecordSourceWarn
  ) {}

  /** 此刻盯着的那份文件。分叉串联会把它换掉，所以续读点要连它一起记。 */
  get currentPath(): string {
    return this.path;
  }

  /** 换一份文件（claude 的分叉串联会把尾读交接到链条最后一份上）。 */
  retarget(path: string): void {
    if (path === this.path) return;
    this.path = path;
    this.offset = 0;
    this.lineOffset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.ino = null;
    this.missing = false;
    this.rewatch();
  }

  /**
   * 整份读一遍，**按块**交出去，并把游标钉在已读末尾。
   *
   * ❌ 不返回"全部行"的数组：本机最大的一份 codex rollout 是 54MB，一次性堆成字符串数组
   * 再解码，峰值内存是文件的好几倍 —— 这条代码跑在 Electron 主进程里，那一下会把
   * 宿主连同它承载的所有会话一起拖垮。按块交出去让每一块用完就能回收。
   */
  async readFromStart(sink: LineSink): Promise<void> {
    this.offset = 0;
    this.lineOffset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.ino = null;
    this.missing = false;
    await this.readInto(sink);
  }

  /**
   * 从上次停下的地方接着读。
   *
   * 先自己核一遍这个续读点还成不成立：同一个 inode、文件没变短、mtime 没往回走。
   * 有一条对不上就当没给过它，整份重读 —— ❌ 不许勉强接着读，接错了拼出来的是
   * 一份**缺了中间**的记录，而它不报错、界面上和"读得慢"分不出来。
   *
   * @returns 真的续上了 = true；续不上 = false（**什么都没读**，由调用方决定怎么重来）。
   */
  async resumeFrom(resume: TailResume, sink: LineSink): Promise<boolean> {
    let info;
    try {
      info = await stat(this.path);
    } catch {
      return false;
    }
    const usable =
      info.ino === resume.ino &&
      info.size >= resume.size &&
      info.mtimeMs >= resume.mtimeMs &&
      resume.lineOffset <= info.size;
    // ❌ 续不上时这里**不读**:调用方还要先把上层那份装回去的状态作废掉,
    // 顺序反了就会「整份重读的内容被旧去重表全吃掉」,留下一份过期且不再更新的历史。
    if (!usable) return false;
    this.offset = resume.lineOffset;
    this.lineOffset = resume.lineOffset;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.ino = info.ino;
    this.missing = false;
    await this.readInto(sink);
    return true;
  }

  /** 此刻的续读点。文件还没读过（或读不到）时返回 null。 */
  async resumePoint(): Promise<TailResume | null> {
    if (this.ino === null) return null;
    try {
      const info = await stat(this.path);
      if (info.ino !== this.ino) return null;
      return { ino: this.ino, size: info.size, mtimeMs: info.mtimeMs, lineOffset: this.lineOffset };
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.stopped) return;
    this.timer = setInterval(() => void this.pump(), this.pollIntervalMs);
    this.timer.unref?.();
    this.rewatch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** 立刻对账一次。测试直接调它，免得把用例时长押在轮询节拍上。 */
  async pump(): Promise<void> {
    if (this.stopped || this.inflight) return;
    await this.run();
  }

  /**
   * 追到此刻的文件尾:等正在跑的那一趟读完(它开始时文件里还没有的行它读不到),再读一趟。
   * 返回时这一刻之前写进文件的每一行都已交给 `onLines`。
   */
  async catchUp(): Promise<void> {
    while (this.inflight) await this.inflight;
    if (this.stopped) return;
    await this.run();
  }

  private run(): Promise<void> {
    const run = this.readOnce().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async readOnce(): Promise<void> {
    try {
      // restart 必须在任何一行之前送达，所以先攒着 —— 尾读的增量本来就只有一两块大小。
      const pending: Array<[string[], number[]]> = [];
      const restart = await this.readInto((lines, offsets) => pending.push([lines, offsets]));
      if (restart) this.events.onRestart(restart);
      for (const [lines, offsets] of pending) this.events.onLines(lines, offsets);
    } catch (error) {
      // 读一次失败不等于这份记录没了（EMFILE、临时 EACCES 都会这样）：报出来，下个节拍再试。
      this.warn('尾读失败，将在下个轮询节拍重试', {
        path: this.path,
        error: (error as Error).message
      });
    }
  }

  private rewatch(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.stopped) return;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => void this.pump());
      // watch 自己出错只降级成"纯轮询"，不能把整条时间线带走。
      this.watcher.on('error', (error) => {
        this.warn('fs.watch 失效，退回纯轮询', {
          path: this.path,
          error: (error as Error).message
        });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // 文件还没出现 / 平台不支持：轮询照常跑。
    }
  }

  /**
   * 读增量到 `sink`。返回非 null 表示这份文件已经不是原来那份了。
   */
  private async readInto(sink: LineSink): Promise<TailRestartReason | null> {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      // 只在"从有到无"的那一次报 restart：文件一直不在时反复报会把上层的重载打成死循环。
      if (this.missing || this.offset === 0) {
        this.missing = true;
        return null;
      }
      this.missing = true;
      return 'source_unreadable';
    }

    let restart: TailRestartReason | null = null;
    if (this.missing) {
      restart = 'source_replaced';
    } else if (this.ino !== null && info.ino !== this.ino) {
      restart = 'source_replaced';
    } else if (info.size < this.offset) {
      // 变短只可能是被截断/重写：已读的偏移量对新内容毫无意义。
      restart = 'source_replaced';
    }
    if (restart) {
      this.offset = 0;
      this.lineOffset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
    }
    this.missing = false;
    this.ino = info.ino;

    if (info.size <= this.offset) return restart;

    const handle = await open(this.path, 'r');
    try {
      const chunkSize = 256 * 1024;
      const buffer = Buffer.alloc(chunkSize);
      while (this.offset < info.size) {
        const want = Math.min(chunkSize, info.size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, want, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        // `text` 的第一个字符正对着文件里的 `lineOffset` 那个字节 —— 这条对齐关系是
        // lineOffset 能当续读点的全部依据，所以推进它要按**消掉的那一段的字节数**算，
        // ❌ 不能按字符数（一个 CJK 字符 3 字节，按字符算会把偏移量算短一大截）。
        const text = this.partial + this.decoder.write(buffer.subarray(0, bytesRead));
        const parts = text.split('\n');
        this.partial = parts.pop() ?? '';
        // 逐行量字节数(含换行符那一个字节):每行的起点顺手记下,总和就是推进量 —— 与整段量一次是同一笔开销。
        const lines: string[] = [];
        const offsets: number[] = [];
        for (const part of parts) {
          if (part.trim().length > 0) {
            lines.push(part);
            offsets.push(this.lineOffset);
          }
          this.lineOffset += Buffer.byteLength(part, 'utf8') + 1;
        }
        if (lines.length > 0) sink(lines, offsets);
      }
    } finally {
      await handle.close();
    }
    return restart;
  }
}
