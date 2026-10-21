import { describe, expect, it } from 'vitest';
import { recordedContextUsage } from './recorded-context-usage';

const reading = { used: 42_000, size: 200_000, modelId: 'gpt-5.5', providerSessionId: 'native-1' };

describe('recordedContextUsage (#7342)', () => {
  it('属于此刻这条原生会话:画出那份读数,花费不说', () => {
    expect(recordedContextUsage({ contextUsage: reading, providerSessionId: 'native-1' }, null)).toEqual({
      contextUsed: 42_000,
      contextSize: 200_000,
      cost: null,
    });
    expect(recordedContextUsage({ contextUsage: reading, providerSessionId: 'native-1' }, 'gpt-5.5')).not.toBeNull();
  });

  it('原生会话换了(重来 / 换计费路)或还没有:不是它的读数', () => {
    expect(recordedContextUsage({ contextUsage: reading, providerSessionId: 'native-2' }, null)).toBeNull();
    expect(recordedContextUsage({ contextUsage: reading, providerSessionId: undefined }, null)).toBeNull();
  });

  it('此刻的模型说得出且不是量它时那个:上限不属于它', () => {
    expect(recordedContextUsage({ contextUsage: reading, providerSessionId: 'native-1' }, 'gpt-5.5-mini')).toBeNull();
  });

  it('没有记录 / 没有读数:没有可画的', () => {
    expect(recordedContextUsage(undefined, null)).toBeNull();
    expect(recordedContextUsage({ providerSessionId: 'native-1' }, null)).toBeNull();
  });
});
