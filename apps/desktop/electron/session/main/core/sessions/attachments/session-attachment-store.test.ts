/**
 * 附件落盘与登记这两半，以及「没有主人的目录」怎么被认出来（#5269）。
 *
 * 为什么要分两半：新建页在**会话还不存在**的时候就得给出附件的绝对路径（首轮正文里那条
 * mention 指着它），而 `session_attachments` 有指向 `conversations` 的外键 —— 那时插不进去。所以
 * 落盘（`stageSessionAttachment`）与登记（`recordSessionAttachments`）必须能分开跑。
 *
 * ⚠️ 这一组里最要紧的是两条**反向对照**：
 *   · 落盘那一步一行库都不许写 —— 否则外键当场判死，新建页那条路根本走不通；
 *   · 清扫器不许碰**有主**的目录 —— 一个「无脑清空整棵树」的实现同样能让「孤儿被删掉」变绿。
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  liveSessions: [] as { id: string }[],
  /** 库里登记过的附件行(清扫器读整表、删除读这条会话的副本行)。 */
  attachmentRows: [] as { storedPath: string }[],
  copyRows: [] as { storedPath: string }[],
  inserted: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/should-not-be-used' },
  clipboard: {},
  nativeImage: {},
}));

vi.mock('@main/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      // 几种读法都要撑住:整表读会话 / 附件行(清扫器),按会话读副本行(删除),以及带 orderBy/limit 的单行查副本。
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) =>
          Object.assign(
            Promise.resolve(getTableName(table) === 'sessions' ? mocks.liveSessions : mocks.attachmentRows),
            {
              where: () =>
                Object.assign(Promise.resolve(mocks.attachmentRows), {
                  orderBy: () => ({ limit: () => Promise.resolve(mocks.copyRows) }),
                }),
            }
          ),
      }),
      insert: () => ({
        values: (rows: unknown) => {
          mocks.inserted.push(rows);
          return Promise.resolve();
        },
      }),
    },
  };
});

const {
  findSessionAttachmentCopy,
  recordSessionAttachments,
  resolveSessionAttachmentPath,
  stageSessionAttachment,
  sweepOrphanSessionAttachmentDirectories,
  sessionAttachmentDirectory,
} = await import('./session-attachment-store');

let userData = '';

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'gugu-attachments-'));
  mocks.liveSessions = [];
  mocks.attachmentRows = [];
  mocks.copyRows = [];
  mocks.inserted = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('stageSessionAttachment', () => {
  it('粘贴来的字节落进 <userData>/task-attachments/<会话 id>/，并且**一行库都不写**', async () => {
    const staged = await stageSessionAttachment(
      {
        sessionId: 'c1',
        name: 'pasted-text.txt',
        mimeType: 'text/plain',
        size: 5,
        bytes: new TextEncoder().encode('hello'),
      },
      userData
    );

    expect(staged.storedPath.startsWith(sessionAttachmentDirectory('c1', userData))).toBe(true);
    expect(await readFile(staged.storedPath, 'utf8')).toBe('hello');
    // 盘上的名字带 id 防重名，用户读的那个名字走 `name` 字段。
    expect(staged.storedPath).toContain('pasted-text');
    expect(staged.name).toBe('pasted-text.txt');
    // 没有原路径可给 ⇒ mention 只能指副本。
    expect(staged.originalPath).toBeUndefined();
    expect(staged.mentionPath).toBe(staged.storedPath);
    // ⚠️ 反向对照：这一步要是顺手插了库，会话还没建出来 ⇒ 外键当场判死。
    expect(mocks.inserted).toEqual([]);
  });

  /**
   * owner 2026-09-10 拍板改的那一条:拖进来的**也存一份**。只记指向的话,那件东西同时依赖
   * 「原文件还在不在」与「它在不在 home 里」——home 之外 `openPath` 直接判死。
   */
  it('拖进来的文件照样存一份，原路径只用来决定 mention 指向谁', async () => {
    const original = join(userData, 'notes.md');
    await writeFile(original, '# 我的笔记');

    const staged = await stageSessionAttachment(
      {
        sessionId: 'c1',
        name: 'notes.md',
        mimeType: 'text/markdown',
        size: 9,
        bytes: new TextEncoder().encode('# 我的笔记'),
        originalPath: original,
      },
      userData
    );

    // ① 副本真的落了盘,内容一致
    expect(staged.storedPath.startsWith(sessionAttachmentDirectory('c1', userData))).toBe(true);
    expect(await readFile(staged.storedPath, 'utf8')).toBe('# 我的笔记');
    // ② 原路径记着,而且 mention 指的是**它**(用户可能正想让 agent 就地改那个文件)
    expect(staged.originalPath).toBe(original);
    expect(staged.mentionPath).toBe(original);
    // ⚠️ 反向对照:mention 指原路径 ≠ 没有副本。少了 ① 那两条,一个「照旧只记指向」的实现
    // 同样能让 ② 变绿 —— 而那正是「home 之外点开就打不开」的由来。
    expect(mocks.inserted).toEqual([]);
  });

});

describe('recordSessionAttachments', () => {
  it('会话建出来之后补登记，一件一行', async () => {
    await recordSessionAttachments('c1', [
      {
        id: 'a1',
        storedPath: '/u/a1.png',
        mentionPath: '/u/a1.png',
        name: 'a.png',
        mimeType: 'image/png',
        size: 12,
      },
      {
        id: 'a2',
        storedPath: '/u/a2.md',
        originalPath: '/Users/me/n.md',
        mentionPath: '/Users/me/n.md',
        name: 'n.md',
        size: 3,
      },
    ]);

    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]).toEqual([
      {
        id: 'a1',
        sessionId: 'c1',
        name: 'a.png',
        mimeType: 'image/png',
        size: 12,
        storedPath: '/u/a1.png',
        originalPath: null,
        origin: 'copy',
      },
      {
        id: 'a2',
        sessionId: 'c1',
        name: 'n.md',
        mimeType: null,
        size: 3,
        storedPath: '/u/a2.md',
        originalPath: '/Users/me/n.md',
        origin: 'copy',
      },
    ]);
  });

});

async function seedDirs(userDataDir: string, ...names: string[]): Promise<void> {
  for (const id of names) {
    const dir = sessionAttachmentDirectory(id, userDataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.bin'), 'x');
  }
}

describe('sweepOrphanSessionAttachmentDirectories', () => {
  it('没有主人的目录被清掉;有主 = 名字是一条还在的会话,或库里有行的副本落在它里面', async () => {
    await seedDirs(userData, 'live-session', 'never-created', 'old-id');
    mocks.liveSessions = [{ id: 'live-session' }];
    // 迁移前按旧 id 起名的目录:靠登记行认主。
    mocks.attachmentRows = [{ storedPath: join(sessionAttachmentDirectory('old-id', userData), 'a.bin') }];

    const removed = await sweepOrphanSessionAttachmentDirectories(userData);

    expect(removed).toBe(1);
    const left = (await readdir(join(userData, 'task-attachments'))).sort();
    // ⚠️ 反向对照：留下的必须**正好**是有主的那两个 —— 只断言孤儿没了的话，
    // 一个「整棵树删光」的实现照样绿，而那会当场删掉用户所有历史消息里的附件。
    expect(left).toEqual(['live-session', 'old-id']);
  });

});

/**
 * 消息里那条 mention 指着用户自己那个文件(agent 要改的就是它),但**显示与点开必须走副本** ——
 * 原路径依赖「文件还在不在」和「在不在 home 里」,而 home 之外 `openPath` 直接判死。
 */
describe('resolveSessionAttachmentPath', () => {
  it('有副本就用副本', async () => {
    mocks.copyRows = [{ storedPath: '/u/task-attachments/c1/abc-notes.md' }];
    await expect(resolveSessionAttachmentPath('c1', '/Volumes/SSD/notes.md')).resolves.toBe(
      '/u/task-attachments/c1/abc-notes.md'
    );
    await expect(findSessionAttachmentCopy('c1', '/Volumes/SSD/notes.md')).resolves.toBe(
      '/u/task-attachments/c1/abc-notes.md'
    );
  });

  it('❌ 查不到副本就原样返回 —— 工作区文件的 mention 走的正是这一支,它就该开原文件', async () => {
    mocks.copyRows = [];
    await expect(resolveSessionAttachmentPath('c1', '/repo/src/index.ts')).resolves.toBe(
      '/repo/src/index.ts'
    );
    await expect(findSessionAttachmentCopy('c1', '/repo/src/index.ts')).resolves.toBeNull();
  });
});
