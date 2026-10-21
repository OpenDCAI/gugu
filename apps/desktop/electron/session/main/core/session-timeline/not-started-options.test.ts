import { describe, expect, it } from 'vitest';
import { notStartedSessionOptions } from './not-started-options';

describe('notStartedSessionOptions(没开起来的会话,输入框上的模型胶囊照样在)', () => {
  it('咕咕提供的模型:按平台 id 报,名字取那台机器的目录', () => {
    expect(
      notStartedSessionOptions({ model: null, platformModelId: 'gpt-5', names: new Map([['platform:gpt-5', 'GPT-5']]) })
    ).toEqual({ mode: null, effort: null, model: { selected: 'platform:gpt-5', available: [{ id: 'platform:gpt-5', name: 'GPT-5' }] } });
  });

  it('自家模型;目录读不到就用 id 当名字', () => {
    expect(notStartedSessionOptions({ model: 'o3', platformModelId: null, names: new Map() }).model).toEqual({
      selected: 'o3',
      available: [{ id: 'o3', name: 'o3' }],
    });
  });

  it('没选过模型(这家默认):不摆模型胶囊', () => {
    expect(notStartedSessionOptions({ model: '', platformModelId: undefined, names: new Map() }).model).toBeNull();
  });
});
