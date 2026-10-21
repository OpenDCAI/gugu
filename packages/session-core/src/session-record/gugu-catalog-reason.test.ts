import { describe, expect, it } from 'vitest';
import {
  GUGU_CATALOG_EMPTY_REASON,
  guguCatalogReasonCode,
  guguCatalogReasonKind,
  guguReasonInText,
  guguReasonOf,
} from './contract';

describe('guguCatalogReasonKind (#6264 咕咕那一组缺席的原因)', () => {
  it('reads the codes the host sends', () => {
    expect(guguCatalogReasonKind(guguCatalogReasonCode('service-unavailable'))).toBe('service-unavailable');
    expect(guguCatalogReasonKind(guguCatalogReasonCode('no-identity-chat'))).toBe('no-identity-chat');
  });

  it('has nothing to say for an empty slot', () => {
    expect(guguCatalogReasonKind(null)).toBeNull();
    expect(guguCatalogReasonKind('  ')).toBeNull();
  });

  it('keeps understanding the sentences older hosts sent', () => {
    expect(guguCatalogReasonKind(GUGU_CATALOG_EMPTY_REASON)).toBe('none-for-agent');
    expect(guguCatalogReasonKind('Agent 运行时尚未连接')).toBe('runtime-not-connected');
    expect(guguCatalogReasonKind('咕咕模型目录还没接上(宿主未就绪)')).toBe('host-not-ready');
  });

  it('never lets a raw server message through as copy', () => {
    // d22 真机:旧宿主把 model-access 的 503 原文塞进了这一格。
    expect(guguCatalogReasonKind('model access server is not configured')).toBe('unknown');
    expect(guguCatalogReasonKind('gugu-models:not-a-reason')).toBe('unknown');
  });
});

describe('guguReasonInText', () => {
  it('finds the code inside a start failure however it was wrapped', () => {
    expect(guguReasonInText("Error invoking remote method 'acp:start': Error: gugu-models:signed-out")).toBe('signed-out');
    expect(guguReasonInText('spawn failed: model access server is not configured')).toBeNull();
    expect(guguReasonInText('gugu-models:bogus')).toBeNull();
  });

  it('reads a membership refusal and a retired model (#7092 / #7103)', () => {
    expect(guguReasonInText("Error invoking remote method 'pty:start': Error: gugu-models:membership-required")).toBe('membership-required');
    expect(guguReasonInText('gugu-models:model-unavailable')).toBe('model-unavailable');
  });
});

describe('guguReasonOf (#7103 转录里「回合失败」那一格的原因)', () => {
  it('reads a known reason and falls back to unknown', () => {
    expect(guguReasonOf('membership-required')).toBe('membership-required');
    expect(guguReasonOf('model-unavailable')).toBe('model-unavailable');
    expect(guguReasonOf('credits_exhausted')).toBe('unknown');
  });
});
