import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { app } from 'electron';
import { db } from '@main/db/client';
import { and, desc, eq } from 'drizzle-orm';
import { sessions, sessionAttachments } from '@main/db/schema';
import { log } from '@main/lib/logger';
import {
  inferDroppedBlobExtension,
  MAX_DROPPED_BLOB_BYTES,
  normalizeDroppedImageBytes,
  sanitizeDroppedBlobName,
} from '@main/core/pty/persist-dropped-blob';

/**
 * 输入框附件落在哪儿(#5269)。
 *
 * **在自己的地盘存一份,而不是给某道闸开口子。** 这些字节从前落在 `$TMPDIR/gugu-dropped-blobs`:
 * 那是一次投递的传输缓冲,退出即清、24 小时扫,而消息里的 mention 却长期指着它 ——
 * 传输方式同时充当了记录,于是历史消息里的附件迟早点不开。顺带地,临时目录在 home 之外,
 * 连「点开」那一下都要给 `AppService.openPath` 的 home jail 开口子。
 *
 * 落进 `<userData>/task-attachments/<会话 id>/` 之后两件事一起没了:userData 本来就在 home 里,
 * jail 一行都不用改;附件跟随任务历史保留,归档不删附件。
 *
 * 根目录名 `task-attachments` 是磁盘路径,不随概念改名。库里每一行记着自己的绝对路径 `stored_path`,
 * 归属只认这一列:迁移前的附件还在按旧 id 起名的子目录里,照样能用。
 */
export function sessionAttachmentsRoot(userDataDir: string = app.getPath('userData')): string {
  return join(userDataDir, 'task-attachments');
}

export function sessionAttachmentDirectory(sessionId: string, userDataDir?: string): string {
  return join(sessionAttachmentsRoot(userDataDir), sessionId);
}

export type PersistSessionAttachmentInput = {
  sessionId: string;
  name: string;
  mimeType?: string;
  size: number;
  /** 这件东西的字节。**恒必须给** —— 一律存一份(见 `stageSessionAttachment` 的抬头)。 */
  bytes: Uint8Array;
  /**
   * 用户自己盘上那个文件在哪(从访达拖进来的才有)。它**不改变要不要拷贝**,只决定
   * 「发给 agent 的 mention 指向谁」。
   */
  originalPath?: string;
};

export type PersistedSessionAttachment = {
  id: string;
  /** 我们自己那一份在哪 —— 消息里的显示与点开都用它。 */
  storedPath: string;
  /** 用户自己那个文件在哪(拖进来的才有)。 */
  originalPath?: string;
  /**
   * **发给 agent 的 mention 该指向谁**:有原路径就是原路径(他要改的是用户那个文件),
   * 没有就退到副本。这一格由存储层算出来,❌ 别让每个调用点各判一次。
   */
  mentionPath: string;
};

/** 已经落好盘、但还没登记进库的一件附件(见 `stageSessionAttachment`)。 */
export type StagedSessionAttachment = PersistedSessionAttachment & {
  name: string;
  mimeType?: string;
  size: number;
};

/**
 * 落盘那一半:写文件(或解析出用户自己那个文件的路径),**不碰库**。
 *
 * 为什么要能单独落盘:新建会话页在**会话还不存在**的时候就得给出这条绝对路径 —— 它要拼进
 * 首轮正文里的 mention。而 `session_attachments` 有指向会话的外键,会话没建出来插不进去。
 * ⇒ 顺序只能是「先落盘拿到最终路径 → 建会话 → 补登记」(`recordSessionAttachments`)。
 * 目录名就是会话 id(新建页事先就定好了),所以即使补登记那一步没跑成(进程中途没了),盘上留下的
 * 也是一个**名字自带归属**的目录,`sweepOrphanSessionAttachmentDirectories` 下次启动能精确认出它。
 */
export async function stageSessionAttachment(
  input: PersistSessionAttachmentInput,
  userDataDir?: string
): Promise<StagedSessionAttachment> {
  const id = randomUUID();

  if (!input.bytes) throw new Error('Attachment needs its bytes');
  if (input.bytes.byteLength > MAX_DROPPED_BLOB_BYTES) {
    throw new Error(`Attachment is too large (${input.bytes.byteLength} bytes)`);
  }

  // HEIC/HEIF 在这里转成 PNG —— 与临时目录那条路同一套归一化,❌ 别写第二份。
  const normalized = await normalizeDroppedImageBytes(input.bytes, {
    name: input.name,
    mimeType: input.mimeType,
  });
  if (normalized.bytes.byteLength > MAX_DROPPED_BLOB_BYTES) {
    throw new Error(`Attachment is too large (${normalized.bytes.byteLength} bytes)`);
  }

  const directory = sessionAttachmentDirectory(input.sessionId, userDataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // 盘上的文件名带 id 防重名;**用户读的名字存在 `name` 列里**,❌ 不从这个文件名反推
  // ——从前正是这一步把 `gugu-drop-<uuid>-` 漏到了用户脸上。
  const safe = sanitizeDroppedBlobName(input.name.replace(/\.[^.]+$/, ''));
  const declaredExt = inferDroppedBlobExtension(input.name, input.mimeType);
  const ext = normalized.ext || declaredExt;
  const path = join(directory, `${id}${safe ? `-${safe}` : ''}${ext}`);
  await writeFile(path, normalized.bytes);

  // HEIC/HEIF 在上面被转成了 PNG。那时原路径指着的仍是 `.heic` —— agent 读不懂,
  // ⇒ 这一件的 mention 只能指副本。判据是**扩展名变了没有**,不是文件类型的名字。
  const converted = ext !== declaredExt;
  const originalPath = converted ? undefined : input.originalPath;
  return {
    id,
    storedPath: path,
    originalPath,
    mentionPath: originalPath ?? path,
    name: input.name,
    mimeType: input.mimeType,
    size: normalized.bytes.byteLength,
  };
}

/**
 * 登记那一半:会话真的建出来之后,把已经落好盘的那几件写进库(外键这时才成立)。
 *
 * 一件都没有就直接返回 —— ❌ 别插空数组去撞一次没必要的写。
 */
export async function recordSessionAttachments(
  sessionId: string,
  entries: readonly StagedSessionAttachment[]
): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(sessionAttachments).values(
    entries.map((entry) => ({
      id: entry.id,
      sessionId: sessionId,
      name: entry.name,
      mimeType: entry.mimeType ?? null,
      size: entry.size,
      storedPath: entry.storedPath,
      originalPath: entry.originalPath ?? null,
      // 新行恒为 copy(一律存一份)。库里 2026-09-10 前的 reference 行 stored_path 指着用户的文件,下面的查询按列排除。
      origin: 'copy' as const,
    }))
  );
}

/**
 * 一条 mention 指着的东西,我们自己有没有留着一份(#5269)。
 *
 * 消息正文里的 mention 目标是**原路径**(用户拖进来的那个文件),因为 agent 要改的是它。
 * 但显示与点开不能跟着走原路径 —— 那条路依赖「文件还在不在」和「在不在 home 里」两件我们
 * 管不了的事。所以显示前先来这里问一句:有副本就用副本。
 *
 * ⚠️ 按 `(会话, originalPath)` 查,❌ 不跨会话:同一个文件在两条会话里各留了一份,
 * 各自跟着各自的会话生灭,拿错那一份会在会话被删之后指向一个已经不存在的副本。
 * 同一会话里同一路径附了多次就取最新的那份 —— 它们的字节在附上去那一刻是同一个东西。
 *
 * ❌ 也不要拿它当「这个路径能不能打开」的通用判据:它只回答「这是不是本会话的一件附件」。
 * 工作区文件的 mention 在这里查不到,照旧走原路径,那是对的。
 */
export async function findSessionAttachmentCopy(
  sessionId: string,
  target: string
): Promise<string | null> {
  const [row] = await db
    .select({ storedPath: sessionAttachments.storedPath })
    .from(sessionAttachments)
    .where(
      and(
        eq(sessionAttachments.sessionId, sessionId),
        eq(sessionAttachments.originalPath, target),
        eq(sessionAttachments.origin, 'copy')
      )
    )
    .orderBy(desc(sessionAttachments.createdAt))
    .limit(1);
  return row?.storedPath ?? null;
}

/**
 * 显示与点开该用哪条路径:有副本用副本,没有(工作区文件、或 0026 之前的历史行)用原路径。
 */
export async function resolveSessionAttachmentPath(sessionId: string, target: string): Promise<string> {
  return (await findSessionAttachmentCopy(sessionId, target)) ?? target;
}

/** `path` 在不在附件根目录里(只有那里的字节是我们自己拷的)。 */
function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel !== path;
}

/**
 * 启动时清掉「没有主人的」附件目录。
 *
 * 一个子目录有主 = 它的名字是一条还在的会话(新建页按会话 id 落盘的),或者库里有行的 `stored_path`
 * 落在它里面(迁移前按旧 id 起名的目录)。两样都不是,这一目录的字节就再没有任何东西指向它:
 * 新建页落好盘却没建成任务(用户中途走开、创建失败),或旧版本删除任务后留下了副本。
 * ❌ 不用「超过 N 天」这种时间启发式 —— 归属是确定的,不需要猜。
 *
 * ⚠️ **只在启动时跑。** 运行中跑会误删一个正在被输入框攒着、会话还没建出来的草稿目录 ——
 * 那种目录在库里同样查不到,与孤儿在读数上一模一样,区别只在「有没有人还攥着它」,
 * 而那件事只有渲染层知道。
 */
export async function sweepOrphanSessionAttachmentDirectories(userDataDir?: string): Promise<number> {
  const root = sessionAttachmentsRoot(userDataDir);
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return 0; // 还没有人存过附件
  }
  if (dirs.length === 0) return 0;
  const owned = new Set((await db.select({ id: sessions.id }).from(sessions)).map((row) => row.id));
  for (const { storedPath } of await db
    .select({ storedPath: sessionAttachments.storedPath })
    .from(sessionAttachments)) {
    if (insideRoot(root, storedPath)) owned.add(relative(root, storedPath).split(sep)[0]!);
  }
  let removed = 0;
  for (const name of dirs) {
    if (owned.has(name)) {
      // #6264 有主的目录:只清传了一半的(attachment-upload.ts;启动时不会有正在传的)。不存在即返回。
      await rm(join(root, name, '.incoming'), { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    try {
      await rm(join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch (error: unknown) {
      log.warn('task-attachments: failed to sweep orphan directory', { name, error: String(error) });
    }
  }
  return removed;
}
