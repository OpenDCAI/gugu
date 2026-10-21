import { randomUUID } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { AcpStorageForkContext } from '@gugu/session-core/agents/plugins';

/**
 * Antigravity 的分叉 —— 咕咕在它自己的会话存档上做(#6335)。
 *
 * ## 为什么不用 `session/fork`
 *
 * `agy_acp_server` 1.2.1 的 `initialize` 不报 fork 能力,硬发 `session/fork` 回 `{}`(没有 sessionId,
 * SDK 的缺省桩)。而它的 SDK 支持「同一份存档 + conversation_id 续接」
 * (https://github.com/google-antigravity/antigravity-sdk-python 的 persistence.md),存档就在
 * `$GEMINI_HOME/antigravity-acp/conversations/<id>.db`(+ `<id>.meta`),`session/load` 按 id 读它。
 *
 * ## 为什么要改写 id
 *
 * 只复制文件、换个文件名:`session/load` 能回放,但下一轮报
 * `cascade ID mismatch, executor: <旧>, input: <新>`,**而服务对外回 `end_turn`**(静默失败)。
 * 旧 id 写在库里好几处(`trajectory_meta` 的两列 + 各 protobuf blob 里 22 处),都是 36 字节的
 * ASCII uuid;等长替换不改变任何 protobuf 长度前缀。改写后 `session/load` + 下一轮,模型收到的
 * 请求带着来源会话的全部历史与新一轮的话(2026-09-24 本地假端点实测)。
 *
 * ## 不碰来源
 *
 * 来源会话可能正开着(WAL 模式、另一个进程在写)⇒ 用 SQLite 的 backup 取一份一致快照,
 * ❌ 不裸拷 `.db`(会漏掉还在 `-wal` 里的最新几轮)。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoreContext = Pick<AcpStorageForkContext, 'env' | 'homeDir'>;

function geminiHome(ctx: StoreContext): string {
  return ctx.env.GEMINI_HOME?.trim() || join(ctx.homeDir, '.gemini');
}

/** 聊天面板腿(`agy_acp_server`)的存档目录。 */
export function antigravityConversationsDir(ctx: StoreContext): string {
  return join(geminiHome(ctx), 'antigravity-acp', 'conversations');
}

/**
 * 终端腿(`agy`)的存档目录 —— 同一个托管根下的**另一个**目录,库的形状与聊天面板腿那份相同
 * (`trajectory_meta` / `steps` / `trajectory_metadata_blob` …,agy 1.2.9 实测),没有 `.meta`。
 */
export function antigravityCliConversationsDir(ctx: StoreContext): string {
  return join(geminiHome(ctx), 'antigravity-cli', 'conversations');
}

/** 聊天面板腿的分叉:运行时随后 `session/load` 新 id。 */
export function forkAntigravitySession(
  ctx: AcpStorageForkContext,
  newId: string = randomUUID()
): Promise<{ providerSessionId: string }> {
  return forkAntigravityStore(antigravityConversationsDir(ctx), ctx.sourceProviderSessionId, newId);
}

/**
 * 终端腿的分叉:`agy` 没有任何启动参数能分叉(`--help` 全表;官方 docs/cli/conversations 的 `/fork` 只是
 * TUI 里的斜杠命令,「Your active terminal switches immediately to the new branch」——得先开着来源会话才能打)。
 * ⇒ 同一个做法做在它自己的存档上,宿主随后以 `--conversation <新 id>` 续跑。
 * 实测(2026-09-24,agy 1.2.9 + 本地假端点):分叉后 `agy --conversation <新 id>` 下一轮的模型请求带着来源会话
 * 的历史,来源库的 sha256 前后不变,见 tui.test 与 PR 描述。
 */
export function forkAntigravityCliSession(
  ctx: AcpStorageForkContext,
  newId: string = randomUUID()
): Promise<{ providerSessionId: string }> {
  return forkAntigravityStore(antigravityCliConversationsDir(ctx), ctx.sourceProviderSessionId, newId);
}

async function forkAntigravityStore(dir: string, sourceId: string, newId: string): Promise<{ providerSessionId: string }> {
  // 等长替换的前提:两边都是规范 uuid。形状变了就别猜,响亮失败。
  if (!UUID.test(sourceId) || !UUID.test(newId) || sourceId.length !== newId.length) {
    throw new Error(`Antigravity fork: unexpected session id shape '${sourceId}'`);
  }
  const sourceDb = join(dir, `${sourceId}.db`);
  if (!(await exists(sourceDb))) {
    throw new Error(`Antigravity fork: no stored session ${sourceId} under ${dir}`);
  }
  const targetDb = join(dir, `${newId}.db`);

  const source = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    await backup(source, targetDb);
  } finally {
    source.close();
  }

  const replaced = rewriteProviderSessionId(targetDb, sourceId, newId);
  if (replaced === 0) {
    throw new Error(`Antigravity fork: session id ${sourceId} not found inside its store — format changed?`);
  }
  // `.meta` 只记 cwd 与权限档(实测 `{"cwd":…,"mode_id":…}`),不含 id ⇒ 原样带过去。
  const sourceMeta = join(dir, `${sourceId}.meta`);
  if (await exists(sourceMeta)) await copyFile(sourceMeta, join(dir, `${newId}.meta`));
  return { providerSessionId: newId };
}

/** 把库里每一处(TEXT 与 BLOB)出现的旧 id 等长换成新 id,返回替换次数。 */
export function rewriteProviderSessionId(dbPath: string, oldId: string, newId: string): number {
  const db = new DatabaseSync(dbPath);
  const oldBytes = Buffer.from(oldId);
  const newBytes = Buffer.from(newId);
  let total = 0;
  try {
    db.exec('BEGIN');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(
        (column) => column.name
      );
      const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${quote(name)}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          let next: string | Uint8Array | undefined;
          if (typeof value === 'string' && value.includes(oldId)) {
            total += value.split(oldId).length - 1;
            next = value.split(oldId).join(newId);
          } else if (value instanceof Uint8Array) {
            const buffer = Buffer.from(value);
            const hits = countBytes(buffer, oldBytes);
            if (hits > 0) {
              total += hits;
              next = replaceBytes(buffer, oldBytes, newBytes);
            }
          }
          if (next !== undefined) {
            db.prepare(`UPDATE ${quote(name)} SET ${quote(column)} = ? WHERE rowid = ?`).run(
              next,
              row.__rowid as number
            );
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  return total;
}

function countBytes(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function replaceBytes(haystack: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  const out = Buffer.from(haystack);
  for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + needle.length)) {
    replacement.copy(out, at);
  }
  return out;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
