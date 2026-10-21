// #7199 助理搬家 · 拷文件:把旧家里「它的东西」(记忆、技能、给它的资料、说明里人写的那一段)原样搬到新家。
// 纯逻辑:读写两头交进来(`HomeFs`),桌面用那台机器的 workspace.files.*(assistant-machine-core),单测用内存盘。
// 原则:
//  - 旧家的文件**一个都不动**(只读),拷贝以字节为准(分块、核大小),❌ 当文本读写(资料里有图片、PDF);
//  - 软链接不跟(记忆夹在电脑上是 Claude 夹的软链接目标,真身在工作目录里,从真身读);跳过的逐条回报,不静默;
//    目录列表会把「指向别处的软链接」当普通文件报出来 —— 所以搬之前逐个试读一个字节(probeReadable),读不了的在接过之前就拦;
//  - 单个文件超过一次传输的上限、整批超过总量上限 = 搬之前就失败,❌ 搬一半才发现;
//  - 重来安全:同路径覆盖写,中断后从头再搬得到同一个结果。
import { composeInstructions, splitInstructions } from './assistant-files';

/** 一次传输一块的大小(那台机器一块最多收 512KB,见 workspace-contract)。 */
export const COPY_CHUNK_BYTES = 512 * 1024;
/** 那台机器单个文件最多收 100MB(REMOTE_WORKSPACE_MAX_FILE_BYTES);超了就整个搬不了,搬之前说。 */
export const COPY_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 整批总量上限:再大的资料夹走中转线要等很久,先让人清一清再搬(搬家是一次性的,不该变成挂一晚上)。 */
export const COPY_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export type FsEntry = { name: string; type: 'file' | 'directory' | 'symlink'; size: number; /** 最后修改的时刻(毫秒);读不到 = 不给。 */ mtime?: number | null };

export interface HomeFs {
  /** 列一层;目录不存在 = []。 */
  list(dir: string): Promise<FsEntry[]>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** 写一块;`final` 那一块落盘,回落盘后的大小(核对用)。 */
  writeChunk(args: {
    path: string;
    uploadId: string;
    offset: number;
    data: Uint8Array;
    total: number;
    final: boolean;
  }): Promise<{ size: number } | null>;
  /** 在已存在的 parent 下建一层文件夹;已经有了不算错。 */
  makeDir(parent: string, name: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
}

export type CopyPlan = {
  /** 要建的目录(相对根,父在前)。 */
  dirs: string[];
  files: { rel: string; size: number; mtime: number | null }[];
  skipped: { rel: string; reason: 'symlink' | 'file-too-large' }[];
  totalBytes: number;
};

export class MoveCopyError extends Error {
  constructor(
    readonly code: 'too_large' | 'copy_mismatch' | 'file_too_large' | 'unreadable',
    message: string
  ) {
    super(message);
    this.name = 'MoveCopyError';
  }
}

const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

/** 数一遍:要拷哪些、跳过哪些、一共多少字节。只读。 */
export async function planTree(fs: HomeFs, root: string): Promise<CopyPlan> {
  const plan: CopyPlan = { dirs: [], files: [], skipped: [], totalBytes: 0 };
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await fs.list(abs)) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === 'symlink') {
        plan.skipped.push({ rel: entryRel, reason: 'symlink' });
      } else if (entry.type === 'directory') {
        plan.dirs.push(entryRel);
        await walk(join(abs, entry.name), entryRel);
      } else if (entry.size > COPY_MAX_FILE_BYTES) {
        plan.skipped.push({ rel: entryRel, reason: 'file-too-large' });
      } else {
        plan.files.push({ rel: entryRel, size: entry.size, mtime: entry.mtime ?? null });
        plan.totalBytes += entry.size;
      }
    }
  }
  await walk(root, '');
  return plan;
}

/** 总量越界 / 有放不进新家的大文件 = 搬之前抛,带人话能用的数字。 */
export function assertPlanFits(plan: CopyPlan, label: string): void {
  const big = plan.skipped.find((entry) => entry.reason === 'file-too-large');
  if (big) throw new MoveCopyError('file_too_large', `${label}里「${big.rel}」超过 ${COPY_MAX_FILE_BYTES / 1024 / 1024}MB,搬不过去`);
  if (plan.totalBytes > COPY_MAX_TOTAL_BYTES) {
    throw new MoveCopyError('too_large', `${label}共 ${Math.ceil(plan.totalBytes / 1024 / 1024)}MB,超过 ${COPY_MAX_TOTAL_BYTES / 1024 / 1024}MB`);
  }
}

/** 几棵树加起来的总量:单棵都不超、合起来超了也算超(搬家一次性的,不该变成挂一晚上)。 */
export function assertTotalFits(totalBytes: number): void {
  if (totalBytes > COPY_MAX_TOTAL_BYTES) {
    throw new MoveCopyError('too_large', `共 ${Math.ceil(totalBytes / 1024 / 1024)}MB,超过 ${COPY_MAX_TOTAL_BYTES / 1024 / 1024}MB`);
  }
}

/**
 * 逐个试读一个字节:目录列表看不出「指向别处、读不了的软链接」,拷到一半才发现就晚了(那时已经接过)。
 * 读不了的第一个就抛,带相对路径(界面只说「有读不了的文件」,路径进日志)。
 */
export async function probeReadable(fs: HomeFs, root: string, plan: CopyPlan, concurrency = 6): Promise<void> {
  const queue = plan.files.filter((file) => file.size > 0);
  let failure: MoveCopyError | null = null;
  const worker = async () => {
    for (;;) {
      const file = queue.shift();
      if (!file || failure) return;
      try {
        await fs.readChunk(join(root, file.rel), 0, 1);
      } catch (cause) {
        failure ??= new MoveCopyError('unreadable', `${file.rel} 读不了:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  if (failure) throw failure;
}

/** 第二遍只拷「第一遍之后新出现 / 改过」的文件(大小或修改时刻变了):搬的过程中旧家里的助理还在写东西。 */
export function diffPlan(previous: CopyPlan, next: CopyPlan): CopyPlan {
  const before = new Map(previous.files.map((file) => [file.rel, file]));
  const files = next.files.filter((file) => {
    const old = before.get(file.rel);
    // 没有修改时刻可比 = 只能比大小,同大小的原地改写看不出(列表不给时刻的那一头无法更准)。
    return !old || old.size !== file.size || (old.mtime !== null && file.mtime !== null && old.mtime !== file.mtime);
  });
  return { ...next, files, totalBytes: files.reduce((n, file) => n + file.size, 0) };
}

/** 从 `base`(已存在)往下把 `target` 的每一层建出来;`target` 必须在 `base` 里面。 */
export async function ensureDirChain(fs: HomeFs, base: string, target: string): Promise<void> {
  const trimmedBase = base.replace(/\/+$/, '');
  if (!target.startsWith(`${trimmedBase}/`)) throw new Error(`${target} is not inside ${base}`);
  let current = trimmedBase;
  for (const segment of target.slice(trimmedBase.length + 1).split('/').filter(Boolean)) {
    await fs.makeDir(current, segment);
    current = `${current}/${segment}`;
  }
}

async function copyFile(
  from: HomeFs,
  fromPath: string,
  to: HomeFs,
  toPath: string,
  size: number,
  onBytes: (n: number) => void
): Promise<void> {
  const uploadId = crypto.randomUUID();
  let offset = 0;
  let committed: { size: number } | null = null;
  do {
    // 只读到登记的大小为止:文件在这期间被加长了,新长出来的不要(整批以数的那一刻为准)。
    const data = await from.readChunk(fromPath, offset, Math.min(COPY_CHUNK_BYTES, size - offset));
    const final = offset + data.length >= size;
    // 读到的比登记的少(文件在这期间被改短了)= 这次拷不完整,不当成成功。
    if (data.length === 0 && !final) throw new MoveCopyError('copy_mismatch', `读 ${fromPath} 提前结束(${offset}/${size})`);
    committed = await to.writeChunk({ path: toPath, uploadId, offset, data, total: size, final });
    offset += data.length;
    onBytes(data.length);
  } while (offset < size);
  if (!committed || committed.size !== size) {
    throw new MoveCopyError('copy_mismatch', `${toPath} 写完是 ${committed?.size ?? '未知'} 字节,应为 ${size}`);
  }
}

/**
 * 按计划把 `fromRoot` 整棵树拷到 `toRoot`(`toRoot` 的各级目录自动建,`toBase` 以上必须已存在)。
 * 只写不删:新家里原来就有的别的文件不碰。返回拷了几个文件。
 */
export async function copyTree(args: {
  from: HomeFs;
  fromRoot: string;
  to: HomeFs;
  toBase: string;
  toRoot: string;
  plan: CopyPlan;
  onBytes?: (n: number) => void;
}): Promise<number> {
  const { from, fromRoot, to, toBase, toRoot, plan } = args;
  await ensureDirChain(to, toBase, toRoot);
  for (const dir of plan.dirs) {
    const slash = dir.lastIndexOf('/');
    const parent = slash < 0 ? toRoot : join(toRoot, dir.slice(0, slash));
    await to.makeDir(parent, slash < 0 ? dir : dir.slice(slash + 1));
  }
  for (const file of plan.files) {
    await copyFile(from, join(fromRoot, file.rel), to, join(toRoot, file.rel), file.size, args.onBytes ?? (() => undefined));
  }
  return plan.files.length;
}

/**
 * 说明(CLAUDE.md):管家那一段各家自己写(新家的管家段不能被旧家的盖掉),只搬人写的那一段:
 * 新家那份的管家段照原样留着,人写的换成旧家的。旧家没有说明 = 什么都不做(❌ 把新家的清空)。
 * 返回有没有写。
 */
export async function copyUserInstructions(args: {
  from: HomeFs;
  fromPath: string;
  to: HomeFs;
  toPath: string;
}): Promise<boolean> {
  const source = await args.from.readText(args.fromPath);
  if (source == null) return false;
  const user = splitInstructions(source).user;
  const current = (await args.to.readText(args.toPath)) ?? '';
  // 旧家人写的是空、新家也没有人写的 = 不必写(也别把一份只有管家段的文件重写一遍)。
  if (!user && !splitInstructions(current).user) return false;
  await args.to.writeText(args.toPath, composeInstructions(current, user));
  return true;
}
