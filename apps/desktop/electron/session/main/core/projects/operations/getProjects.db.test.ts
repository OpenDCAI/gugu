// 同一个文件夹换一种写法,不能被认成另一个项目(owner 10-10 在 Windows 上撞到两个同名项目)。
// 主机是 Windows 时的规则用 path.win32 跑,与测试机的平台无关。
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projects } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('../path-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-utils')>();
  return { ...actual, projectPathKey: (value: string) => actual.projectPathKey(value, path.win32) };
});

import { getLocalProjectByPath, getProjectPathOccupant } from './getProjects';

const MIXED = 'C:\\Users\\Jeffry\\Documents/gugu coordination 2';
const BACKSLASH = 'C:\\Users\\Jeffry\\Documents\\gugu coordination 2';
const FORWARD = 'C:/Users/Jeffry/Documents/gugu coordination 2';

describe('getLocalProjectByPath', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function insert(id: string, projectPath: string, extra: Partial<typeof projects.$inferInsert> = {}) {
    await fixture.db.insert(projects).values({ id, name: 'gugu coordination 2', path: projectPath, ...extra });
  }

  it('库里那行是混合分隔符:全反斜杠、全正斜杠、带尾斜杠都认得出它', async () => {
    await insert('p-mixed', MIXED);
    for (const spelling of [MIXED, BACKSLASH, FORWARD, `${BACKSLASH}\\`, `${FORWARD}/`]) {
      expect((await getLocalProjectByPath(spelling))?.id, spelling).toBe('p-mixed');
    }
  });

  it('同一文件夹已有两行:取最早的那行', async () => {
    await insert('p-later', BACKSLASH, { createdAt: '2026-10-09 07:49:00' });
    await insert('p-earlier', MIXED, { createdAt: '2026-09-25 02:00:00' });
    expect((await getLocalProjectByPath(FORWARD))?.id).toBe('p-earlier');
  });

  it('SSH 远端项目的路径是别的机器上的,不参与比较', async () => {
    await insert('p-ssh', MIXED, { workspaceProvider: 'ssh' });
    expect(await getLocalProjectByPath(MIXED)).toBeUndefined();
    expect(await getLocalProjectByPath(BACKSLASH)).toBeUndefined();
  });

  it('相对路径响亮报错,不拿进程 cwd 去拼', async () => {
    await expect(getLocalProjectByPath('gugu coordination 2')).rejects.toThrow('绝对路径');
  });

  it('冲突诊断按写库的那一种写法查', async () => {
    await insert('p-ssh', BACKSLASH, { workspaceProvider: 'ssh' });
    expect((await getProjectPathOccupant(`${FORWARD}/`))?.id).toBe('p-ssh');
  });
});
