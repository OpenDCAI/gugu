import { describe, expect, it } from 'vitest';
import { composerModelTriggerLabel } from './composer-model-menu';

describe('composerModelTriggerLabel —— 括号是规格还是身份', () => {
  it('规格:清单里有光秃秃的本名(Claude 的 Opus 那对),照旧剥', () => {
    const siblings = ['Opus', 'Opus (1M context)', 'Sonnet'];
    expect(composerModelTriggerLabel('Opus (1M context)', siblings)).toBe('Opus');
  });

  it('身份:几档只差括号、没有一条叫本名(Antigravity 的 High/Low),留全名(#6335)', () => {
    const siblings = ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)', 'Gemini 3.1 Pro (High)'];
    expect(composerModelTriggerLabel('Gemini 3.8 Flash (Low)', siblings)).toBe('Gemini 3.8 Flash (Low)');
    // 只有一档的那条没有歧义,照旧剥
    expect(composerModelTriggerLabel('Gemini 3.1 Pro (High)', siblings)).toBe('Gemini 3.1 Pro');
  });

  it('不给清单 = 旧行为;剥完为空宁可原样', () => {
    expect(composerModelTriggerLabel('Opus (1M context)')).toBe('Opus');
    expect(composerModelTriggerLabel('(default)')).toBe('(default)');
  });
});
