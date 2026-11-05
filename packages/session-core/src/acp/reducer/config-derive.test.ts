import { describe, expect, it } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { deriveConfigGroups } from './config-derive';

describe('deriveConfigGroups', () => {
  it('lists the options of grouped selects in order (DeepSeek Harness groups models by provider)', () => {
    const model = {
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: '["deepseek-official","deepseek-v4.1-flash"]',
      options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
        { value: '["deepseek-official","deepseek-v4.1-flash"]', name: 'Gugu DeepSeek V4.1 Flash' },
        { value: '["deepseek-official","deepseek-v4-pro"]', name: 'Gugu DeepSeek V4 Pro' },
      ] }],
    } as unknown as SessionConfigOption;
    expect(deriveConfigGroups([model]).modelOptions).toEqual({
      configId: 'model',
      selected: '["deepseek-official","deepseek-v4.1-flash"]',
      available: [
        { id: '["deepseek-official","deepseek-v4.1-flash"]', name: 'Gugu DeepSeek V4.1 Flash' },
        { id: '["deepseek-official","deepseek-v4-pro"]', name: 'Gugu DeepSeek V4 Pro' },
      ],
    });
  });

  it('keeps flat selects as they are', () => {
    const effort = {
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
    } as unknown as SessionConfigOption;
    expect(deriveConfigGroups([effort]).efforts?.available.map((option) => option.id)).toEqual(['low', 'high']);
  });
});
