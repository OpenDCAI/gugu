import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7240「编辑凭据」:存着的授权码只交还给原来那台服务器、原来那个地址(审查实撞:改了服务器又留空授权码,
 * 存着的授权码会被递给新服务器,还多出一条同一地址的账号)。
 */

const store = vi.hoisted(() => ({
  accounts: new Map<string, { accountId: string; credentials: Record<string, unknown> }>(),
}));

vi.mock('./integration-credential-store-instance', () => ({
  integrationCredentialStore: {
    getAccount: async (_id: string, accountId?: string) => (accountId ? store.accounts.get(accountId) ?? null : null),
    upsertAccount: async () => undefined,
    delete: async () => undefined,
  },
}));

const { IntegrationConnectionService } = await import('./integration-connection-service');

const SAVED = 'imap.exmail.qq.com:a@corp.com';

beforeEach(() => {
  store.accounts.clear();
  store.accounts.set(SAVED, {
    accountId: SAVED,
    credentials: {
      email: 'a@corp.com',
      password: 'saved-code',
      imapHost: 'imap.exmail.qq.com:993',
      smtpHost: 'smtp.exmail.qq.com:465',
    },
  });
});

describe('connect(editAccountId)', () => {
  it('改了服务器、授权码留空 → 拒绝,❌ 把存着的授权码递给新服务器', async () => {
    const result = await new IntegrationConnectionService().connect(
      'enterprise-mail',
      { email: 'a@corp.com', password: '', imapHost: 'imap.attacker.example:993', smtpHost: 'smtp.exmail.qq.com:465' },
      SAVED
    );
    expect(result).toEqual({
      success: false,
      error: 'imapHost changed: enter the authorization code again.',
      errorType: 'invalid_input',
    });
  });

  it('那个账号已经不在了 → 说清楚,❌ 当成新账号去连', async () => {
    const result = await new IntegrationConnectionService().connect(
      'enterprise-mail',
      { email: 'a@corp.com', password: '', imapHost: 'imap.exmail.qq.com:993', smtpHost: 'smtp.exmail.qq.com:465' },
      'imap.exmail.qq.com:gone@corp.com'
    );
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('is not saved any more') });
  });
});
