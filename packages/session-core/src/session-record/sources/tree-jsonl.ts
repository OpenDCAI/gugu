import type { RecordEntry, SessionRecordLocator, SessionRecordSource, SessionRecordSourceEvents } from '../contract';
import { forEachJsonLine, pollInterval, warnOf, type RecordSourceWarn, type SessionRecordSourceOptions } from './shared';
import { TailReader } from './tail-reader';

/**
 * 树形 JSONL 会话记录的尾读(pi、qwen):每行一个条目，条目经「自己的 id / 父 id」连成一棵树，
 * 「当前位置」是最后写进去的那一条(叶子)。时间线读的是**从根到叶子那一条分支** —— 两家自己重开会话时
 * 也只走这一条;别的分支是用户回退前的旧路，不是这段对话。
 *
 * 各家只给两样:一行怎么认成树上的节点(`toNode`,不在树上的行回 null),一个节点怎么解成记录条目(`decode`)。
 */
export type TreeNode = { id: string; parentId: string | null; raw: Record<string, unknown> };

export type TreeJsonlFormat = {
  /** 写进告警里的那一家的名字。 */
  name: string;
  toNode(raw: Record<string, unknown>): TreeNode | null;
  decode(node: TreeNode): RecordEntry[];
};

export function createTreeJsonlSource(
  locator: SessionRecordLocator,
  options: SessionRecordSourceOptions | undefined,
  resolve: () => Promise<string>,
  format: TreeJsonlFormat
): SessionRecordSource {
  let tail: TreeJsonlTail | null = null;
  let stopped = false;
  return {
    locator,
    async start(events) {
      const path = await resolve();
      if (stopped) return; // 找文件的工夫里已经被拆了
      tail = new TreeJsonlTail(path, pollInterval(options), format, warnOf(options));
      await tail.start(events);
    },
    catchUp: async () => tail?.catchUp(),
    stop: () => {
      stopped = true;
      tail?.stop();
    }
  };
}

class TreeJsonlTail {
  private reader: TailReader | null = null;
  private nodes = new Map<string, TreeNode>();
  private leaf: string | null = null;
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly pollMs: number,
    private readonly format: TreeJsonlFormat,
    private readonly warn: RecordSourceWarn
  ) {}

  async start(events: SessionRecordSourceEvents): Promise<void> {
    this.reader = new TailReader(
      this.path,
      this.pollMs,
      {
        onLines: (lines) => this.absorb(lines, events),
        onRestart: (reason) => {
          this.nodes.clear();
          this.leaf = null;
          events.onReset(reason);
        }
      },
      this.warn
    );
    // 整份读可能分几块交付 —— 先全部收齐再定叶子，否则一棵有分支的树会在首读里被重置好几次。
    const lines: string[] = [];
    await this.reader.readFromStart((chunk) => lines.push(...chunk));
    for (const node of this.parse(lines)) this.remember(node);
    this.emitPath(events);
    this.reader.start();
  }

  async catchUp(): Promise<void> {
    await this.reader?.catchUp();
  }

  stop(): void {
    this.stopped = true;
    this.reader?.stop();
    this.reader = null;
  }

  private absorb(lines: string[], events: SessionRecordSourceEvents): void {
    if (this.stopped) return;
    const batch: RecordEntry[] = [];
    let moved = false;
    for (const node of this.parse(lines)) {
      const extendsLeaf = node.parentId === this.leaf;
      this.remember(node);
      if (!extendsLeaf) moved = true;
      else if (!moved) batch.push(...this.format.decode(node));
    }
    if (moved) {
      // 叶子跳到了别的分支(回退、重设根):这一段时间线已经不是那一段了，整份重来。
      events.onReset('source_replaced');
      this.emitPath(events);
      return;
    }
    if (batch.length > 0) events.onEntries(batch);
  }

  private remember(node: TreeNode): void {
    this.nodes.set(node.id, node);
    this.leaf = node.id;
  }

  /** 把从根到叶子那一条分支整份交出去。 */
  private emitPath(events: SessionRecordSourceEvents): void {
    const path: TreeNode[] = [];
    const seen = new Set<string>();
    for (let id = this.leaf; id && !seen.has(id); ) {
      seen.add(id);
      const node = this.nodes.get(id);
      if (!node) break;
      path.push(node);
      id = node.parentId;
    }
    const out = path.reverse().flatMap((node) => this.format.decode(node));
    if (out.length > 0) events.onEntries(out);
  }

  private parse(lines: string[]): TreeNode[] {
    const out: TreeNode[] = [];
    forEachJsonLine(lines, this.format.name, this.warn, (raw) => {
      const node = this.format.toNode(raw);
      if (node) out.push(node);
      return true;
    });
    return out;
  }
}
