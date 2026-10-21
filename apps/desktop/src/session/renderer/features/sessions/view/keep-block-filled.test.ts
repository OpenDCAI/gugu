import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { keepBlockFilled } from './keep-block-filled';

// 屏上不止一块时一块 ❌ 空着:空格子没有页签条,关这一块的 × 跟着没了,关不掉(owner 2026-10-10)。
describe('一块别空着:有过页签空了就关,摆上来就空的开它的对话', () => {
  function block(init: { tabs: number; blocks: number }) {
    const state = observable({ ...init });
    const close = vi.fn();
    const cancel = vi.fn();
    const fill = vi.fn(() => cancel);
    const dispose = keepBlockFilled({
      empty: () => state.tabs === 0,
      alone: () => state.blocks <= 1,
      close,
      fill,
    });
    const set = (patch: Partial<typeof state>) => runInAction(() => Object.assign(state, patch));
    return { set, close, fill, cancel, dispose };
  }

  it('关掉最后一枚页签:这一块跟着关掉,❌ 开回对话', () => {
    const b = block({ tabs: 1, blocks: 2 });
    b.set({ tabs: 0 });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(b.fill).not.toHaveBeenCalled();
  });

  it('拖进来 / 重启摆回来时一枚页签都没有:开它的对话,❌ 关掉', () => {
    const b = block({ tabs: 0, blocks: 3 });
    expect(b.fill).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    // 存下的页签就绪后摆回来了;之后人关掉最后一枚,照常关这一块。
    b.set({ tabs: 2 });
    b.set({ tabs: 0 });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(b.fill).toHaveBeenCalledTimes(1);
  });

  it('屏上只剩它一块:空着照旧,留着「+」那一列', () => {
    const b = block({ tabs: 1, blocks: 1 });
    b.set({ tabs: 0 });
    expect(b.close).not.toHaveBeenCalled();
    expect(b.fill).not.toHaveBeenCalled();
  });

  it('只剩它一块时关空了,又拼进来别的:这一块关掉,❌ 留一块关不掉的空块', () => {
    const b = block({ tabs: 1, blocks: 1 });
    b.set({ tabs: 0 });
    b.set({ blocks: 2 });
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('这一块收走了,还没开成的对话不再开', () => {
    const b = block({ tabs: 0, blocks: 2 });
    b.dispose();
    expect(b.cancel).toHaveBeenCalledTimes(1);
  });
});
