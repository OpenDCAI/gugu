import { describe, expect, it } from 'vitest';
import {
  chatMentionProvider,
  issueMentionToken,
  parseIssueMentionToken,
  registerLocalSessionMentions,
  registerIssueMentionIcons,
} from './chat-mention-provider';

describe('chatMentionProvider', () => {
  it('resolves issue tokens with provider icon URLs', () => {
    registerIssueMentionIcons([
      {
        id: 'linear',
        features: ['issues'],
        icon: {
          kind: 'svg',
          variants: [{ minSize: 0, light: '<svg viewBox="0 0 16 16"></svg>' }],
        },
      },
    ]);

    const meta = chatMentionProvider.resolve(issueMentionToken('linear', 'ENG-123'));

    expect(meta).toMatchObject({
      id: 'issue:linear:ENG-123',
      label: 'issue:linear:ENG-123',
      name: 'ENG-123',
      kind: 'issue',
    });
    expect(meta?.iconUrl).toContain('data:image/svg+xml');
  });

  it('delegates non-issue tokens to the workspace file provider', () => {
    const meta = chatMentionProvider.resolve('src/app.ts');

    expect(meta).toMatchObject({
      id: 'src/app.ts',
      label: 'src/app.ts',
      name: 'app.ts',
      kind: 'file',
    });
  });

  it('resolves task-local agent mentions with title and harness icon only in their task URI', () => {
    registerLocalSessionMentions('conversation-1', [
      {
        id: '9fd5746b-1111-4111-8111-111111111111',
        name: 'Codex 1',
        title: 'Fix the delivery route',
        engine: 'codex',
        iconUrl: 'data:image/svg+xml,codex',
      },
    ]);

    const expected = {
      id: 'aid:9fd5746b-1111-4111-8111-111111111111',
      label: 'aid:9fd5746b-1111-4111-8111-111111111111',
      name: 'Codex 1',
      kind: 'custom',
      title: 'Fix the delivery route',
      engine: 'codex',
      iconUrl: 'data:image/svg+xml,codex',
    };

    expect(chatMentionProvider.resolve('aid:9fd5746b-1111-4111-8111-111111111111', 'conversation-1'))
      .toEqual(expected);
    // 2026-09-16 把 `user:` 改名成 `aid:`(与分享浮层那一栏「Agent ID」对齐)之前发出去的消息里
    // 写的是旧拼法,它们仍在聊天记录里 —— 必须照样解析成**同一枚** pill(id/label 归一到新写法),
    // ❌ 否则那些老消息的 pill 当场退化成裸文本。
    expect(chatMentionProvider.resolve('user:9fd5746b-1111-4111-8111-111111111111', 'conversation-1'))
      .toEqual(expected);
    expect(chatMentionProvider.resolve('aid:9fd5746b-1111-4111-8111-111111111111', 'other-task'))
      .toBeNull();
    expect(chatMentionProvider.resolve('user:9fd5746b-1111-4111-8111-111111111111', 'other-task'))
      .toBeNull();
  });
});

describe('parseIssueMentionToken', () => {
  it('parses provider and identifier from issue tokens', () => {
    expect(parseIssueMentionToken('issue:github:123')).toEqual({
      token: 'issue:github:123',
      provider: 'github',
      identifier: '123',
    });
  });

  it('returns null for non-issue tokens', () => {
    expect(parseIssueMentionToken('src/app.ts')).toBeNull();
  });
});
