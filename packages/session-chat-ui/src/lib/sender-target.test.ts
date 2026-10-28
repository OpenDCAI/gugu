import { describe, expect, it } from 'vitest';
import { conversationAgentTarget, messageSenderTarget } from './sender-target';

const actor = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333';
describe('sender-name destinations', () => {
  it('opens the original group message instead of the sender private chat', () => {
    expect(messageSenderTarget({ chatKind: 'group', sourceLink: `gugu-chat://${chat}/${message}`, fromId: `user:${actor}` })).toEqual({ kind: 'chat', chatId: chat, messageId: message });
  });
  it('opens directly delivered sessions and user identities by their real addresses', () => {
    expect(messageSenderTarget({ chatKind: undefined, sourceLink: null, fromId: `session:${actor}` })).toEqual({ kind: 'session', sessionId: actor });
    expect(messageSenderTarget({ chatKind: undefined, sourceLink: null, fromId: `user:${actor}` })).toEqual({ kind: 'sender', userId: actor });
  });
  it('does not invent a destination from a name or a system sender', () => {
    for (const fromId of [null, 'system:gugu', 'Claude 3', 'user:not-an-id']) expect(messageSenderTarget({ chatKind: undefined, sourceLink: null, fromId })).toBeNull();
  });
  it('opens an external agent identity when the host has no readable session', () => {
    expect(conversationAgentTarget({ userId: actor })).toEqual({ kind: 'sender', userId: actor });
    expect(conversationAgentTarget({ sessionId: chat, userId: actor })).toEqual({ kind: 'session', sessionId: chat });
    expect(conversationAgentTarget({})).toBeNull();
  });
});
