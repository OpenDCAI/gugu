import { describe, expect, it } from 'vitest';
import { ASK_SOURCES, type AskSource } from '@gugu/session-core/session-record/contract';
import { ASK_SOURCE_SPEC, type AskSourceSpec } from './sources';

describe('Ask source registry', () => {
  it('registers exactly the exhaustive contract union', () => {
    const complete: Record<AskSource, AskSourceSpec> = ASK_SOURCE_SPEC;
    expect(Object.keys(complete).sort()).toEqual([...ASK_SOURCES].sort());
    expect(complete['app-install'].timeoutMs).toBe(280_000);
    expect(complete['browser-assistance'].timeoutMs).toBe(600_000);
    expect(complete['browser-assistance'].waitKind).toBe('dialog');
  });
});
