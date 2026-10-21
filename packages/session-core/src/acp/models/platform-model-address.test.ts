import { describe, expect, it } from 'vitest';
import {
  claudePlatformModelOption,
  platformModelIdFromNativeOption,
  platformModelIdFromRuntimeOption,
  runtimeOptionForPlatformModelId,
} from './platform-model-address';

describe('platform model addressing on a live session', () => {
  it('reads the opencode / pi form back to the canonical id', () => {
    expect(platformModelIdFromRuntimeOption('gugu-platform/glm-5', ['glm-5'])).toBe('glm-5');
    expect(platformModelIdFromNativeOption('gugu-platform/glm-5.3-flash')).toBe('glm-5.3-flash');
  });

  it('reads the ZCode bridge form (providerId\\modelId) back to the canonical id', () => {
    expect(platformModelIdFromNativeOption('gugu-platform\\gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(runtimeOptionForPlatformModelId('gpt-5.6-terra', [
      'builtin:bigmodel-coding-plan\\GLM-5.3',
      'gugu-platform\\gpt-5.6-terra',
    ])).toBe('gugu-platform\\gpt-5.6-terra');
    expect(platformModelIdFromNativeOption('builtin:bigmodel-coding-plan\\GLM-5.3')).toBeNull();
    expect(platformModelIdFromNativeOption('gugu-platform\\')).toBeNull();
  });

  it('never claims a model from another provider namespace', () => {
    expect(platformModelIdFromRuntimeOption('anthropic:glm-5.3', ['glm-5.3'])).toBeNull();
    expect(platformModelIdFromRuntimeOption('openai-api:glm-5.3', ['glm-5.3'])).toBeNull();
    expect(platformModelIdFromNativeOption('anthropic:claude-sonnet-5')).toBeNull();
    expect(platformModelIdFromNativeOption('glm-5.3')).toBeNull();
    // 前缀后面是空的不算一个 id。
    expect(platformModelIdFromNativeOption('gugu-platform/')).toBeNull();
  });

  it('picks the platform form out of a live list that also carries other providers', () => {
    expect(runtimeOptionForPlatformModelId('glm-5.3', [
      'anthropic:claude-sonnet-5',
      'copilot-acp:gpt-5.5',
      'gugu-platform/glm-5.3',
    ])).toBe('gugu-platform/glm-5.3');
    expect(runtimeOptionForPlatformModelId('glm-5.3', ['anthropic:claude-sonnet-5'])).toBeNull();
  });

  it('writes a 1M claude-* model the way Claude Code reads a 1M window, and reads it back', () => {
    expect(claudePlatformModelOption('claude-opus-5', 1_000_000)).toBe('claude-opus-5[1m]');
    // 不足 1M、不是 claude-*(它们靠 CLAUDE_CODE_MAX_CONTEXT_TOKENS)、窗口未知:原样。
    expect(claudePlatformModelOption('claude-opus-5', 500_000)).toBe('claude-opus-5');
    expect(claudePlatformModelOption('glm-5.3', 1_000_000)).toBe('glm-5.3');
    expect(claudePlatformModelOption('claude-opus-5', null)).toBe('claude-opus-5');

    expect(platformModelIdFromRuntimeOption('claude-opus-5[1m]', ['claude-opus-5'])).toBe('claude-opus-5');
    expect(platformModelIdFromNativeOption('[1m]')).toBeNull();
    expect(runtimeOptionForPlatformModelId('claude-opus-5-5', [
      'claude-opus-5[1m]',
      'claude-opus-5-5[1m]',
      'glm-5.3',
    ])).toBe('claude-opus-5-5[1m]');
  });
});
