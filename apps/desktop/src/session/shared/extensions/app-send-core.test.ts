import { describe, expect, it, vi } from 'vitest';

/**
 * `gugu.send` has one answer for the desktop and the phone (摩擦单 F16): `app-send-core.ts`. The desktop's own cases are
 * in `extension-send.test.ts`; here the phone's shape of it — the page's own account, the chat the call names.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const rpcs: Array<Record<string, unknown>> = [];
let rpcError: { code: string; message: string } | null = null;

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === 'users' ? { id: AGENT, type: 'agent' } : { user_id: AGENT }, error: null }),
      };
      return q;
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcs.push(args);
      return { error: rpcError };
    },
  }),
}));

const { ABOUT_GONE, createAppSend } = await import('./app-send-core');
/** The phone's: the page's own account. `chat:relay` is asked at the phone's door (`phoneAppHost`), from the verb's row. */
const phoneSend = createAppSend({ account: async () => ({ token: 'page-token', userId: OWNER }) });

describe('gugu.send on the phone (the shared answer, F16)', () => {
  it('the chat the call names: a whisper to the agent, as the person, via this App', async () => {
    const sent = await phoneSend('dinner-vote', { to: `user:${AGENT}`, text: 'done', chat: GROUP });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpcs.at(-1)).toMatchObject({ p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [AGENT], p_is_whisper: true, p_via_app: 'dinner-vote' });
  });

  it('worked by the person’s agent (owner 10-14): written as that agent, with the person’s token — the database judges it', async () => {
    const WORKER = '33333333-3333-4333-8333-333333333333';
    await phoneSend('dinner-vote', { to: `user:${AGENT}`, text: 'done', chat: GROUP }, { as: WORKER });
    expect(rpcs.at(-1)).toMatchObject({ p_chat_id: GROUP, p_sender_user_id: WORKER, p_to_user_ids: [AGENT], p_is_whisper: true, p_via_app: 'dinner-vote' });
  });

  it('the server’s limit comes back as rate-limited; a call naming no chat — or two ways at once — is invalid, said how', async () => {
    rpcError = { code: 'PT429', message: 'rate-limited' };
    await expect(phoneSend('dinner-vote', { to: `user:${AGENT}`, text: 'again', chat: GROUP })).rejects.toMatchObject({ code: 'rate-limited' });
    rpcError = null;
    const before = rpcs.length;
    for (const where of [{}, { chat: GROUP, refs: [{ file: { id: GROUP } }] }]) {
      await expect(phoneSend('dinner-vote', { to: `user:${AGENT}`, text: 'x', ...where })).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('Say where'),
      });
    }
    // An App still passing `about` (gone 10-14) is told so on the phone too.
    await expect(phoneSend('dinner-vote', { to: `user:${AGENT}`, text: 'x', about: { id: GROUP } })).rejects.toMatchObject({ code: 'invalid', message: ABOUT_GONE });
    expect(rpcs.length).toBe(before);
  });
});
