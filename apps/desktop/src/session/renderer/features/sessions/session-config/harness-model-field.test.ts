import { describe, expect, it } from 'vitest';
import { harnessCatalogNotice } from './harness-model-field';

describe('harnessCatalogNotice:#6264 登录已失效', () => {
  it('登录已失效说「登录已失效」,❌ 说成需要先登录', () => {
    expect(
      harnessCatalogNotice({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null, expired: true }, 'Codex')
    ).toMatchObject({ key: 'harnessCatalog.authExpired', values: { name: 'Codex' }, action: 'login' });
  });

  it('从没登录过照旧', () => {
    expect(
      harnessCatalogNotice({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null }, 'Codex')
    ).toMatchObject({ key: 'harnessCatalog.authRequired' });
  });
});
