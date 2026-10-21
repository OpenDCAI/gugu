import { describe, expect, it } from 'vitest';
import { createFseventsSubscribe } from './fsevents-transport';

/** 一个假的 fsevents 模块:记下 watch 的回调,由测试代替原生层逐条喂路径。 */
function fakeFsevents() {
  let emit: ((eventPath: string, flags: number) => void) | null = null;
  return {
    emit: (eventPath: string) => emit?.(eventPath, 0),
    module: {
      watch(_target: string, handler: (eventPath: string, flags: number) => void) {
        emit = handler;
        return async () => {};
      },
      getInfo: () => ({ event: 'modified' as const }),
      constants: { MustScanSubDirs: 1, RootChanged: 2 },
    },
  };
}

/**
 * 逐条喂 `paths`,一直等到最后一条(必然该送达的那条)出现在回调里,再交出收到的全部路径。
 * 喂进去的顺序就是送达的顺序(被忽略的在 handler 里同步丢掉),所以等到最后一条 = 前面的都已有定论。
 * 不睡墙钟:最后一条始终没来,就由用例超时判红。
 */
async function delivered(root: string, ignore: string[], paths: string[]): Promise<string[]> {
  const fake = fakeFsevents();
  const seen: string[] = [];
  const last = paths[paths.length - 1];
  const arrived = Promise.withResolvers<void>();
  const sub = await createFseventsSubscribe(() => fake.module)(
    root,
    (_err, events) => {
      seen.push(...events.map((e) => e.path));
      if (seen.includes(last)) arrived.resolve();
    },
    { ignore }
  );
  for (const p of paths) fake.emit(p);
  await arrived.promise;
  await sub.unsubscribe();
  return seen;
}

describe('fsevents transport ignore', () => {
  const ignore = ['**/{tmp,.worktrees,node_modules}/**'];

  // 根自己的路径里带一段 tmp / .worktrees(`/private/tmp/…`、`<repo>/.worktrees/x`)时,ignore 只按相对根比 ——
  // 拿绝对路径去比,整个工作区的事件都会被当成「在 tmp 里」丢掉。
  it('does not ignore a workspace because its own path has a segment the ignore names', async () => {
    expect(await delivered('/private/tmp/proj', ignore, ['/private/tmp/proj/a.txt'])).toEqual(['/private/tmp/proj/a.txt']);
    expect(await delivered('/Users/u/repo/.worktrees/feat', ignore, ['/Users/u/repo/.worktrees/feat/a.txt'])).toEqual([
      '/Users/u/repo/.worktrees/feat/a.txt',
    ]);
  });

  it('still ignores the same names below the root', async () => {
    expect(await delivered('/Users/u/proj', ignore, ['/Users/u/proj/node_modules/x/i.js', '/Users/u/proj/tmp/t.txt', '/Users/u/proj/a.txt'])).toEqual([
      '/Users/u/proj/a.txt',
    ]);
  });
});
