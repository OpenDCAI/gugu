import { describe, expect, it } from 'vitest';
import { mergeCommands } from './session-manager';

describe('mergeCommands —— 补出来的 skill 与这一家自己报的命令表(#6335)', () => {
  it('这一家报的排前、同名以它为准;补出来的只补它没有的名字', () => {
    const provider = [{ name: 'plan', description: 'p' }, { name: 'deploy', description: 'from agent' }];
    const merged = mergeCommands(provider, [
      { name: 'deploy', description: 'from disk' },
      { name: 'lint', description: 'l' },
    ]);
    expect(merged).toEqual([
      { name: 'plan', description: 'p' },
      { name: 'deploy', description: 'from agent' },
      { name: 'lint', description: 'l' },
    ]);
  });

  it('这一家的表还没到时,补出来的照样先上面板', () => {
    expect(mergeCommands([], [{ name: 'lint', description: 'l' }])).toEqual([{ name: 'lint', description: 'l' }]);
  });

  it('没有补充 = 原表不动', () => {
    const provider = [{ name: 'plan', description: 'p' }];
    expect(mergeCommands(provider, undefined)).toEqual(provider);
  });
});
