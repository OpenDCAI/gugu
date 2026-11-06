import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rpc: vi.fn(), cached: vi.fn(), agent: vi.fn() }));
vi.mock('@gugu/core/cloud/deviceRuntime', () => ({ readCachedDeviceId: state.cached }));
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent', () => ({ localAgentForSession: state.agent }));
vi.mock('../../../../apps/desktop/electron/supabase', () => ({ makeChatClient: () => ({ rpc: state.rpc }) }));
import { createNativePublicationTransport } from '../../../../apps/desktop/electron/sessionpage/native-publication-transport';
const auth = { userId: 'owner', accessToken: 'fixture', refreshToken: '' };
const entry = { id: 'publication', order: 1, ownerUserId: 'owner', deviceId: 'device', sessionId: 'session', projectId: 'project', agentUserId: 'agent', chatId: 'chat', occurredAt: '2026-11-01T00:00:00Z' };
beforeEach(() => {
  state.rpc.mockReset().mockResolvedValue({ data: { chat_id: 'chat', already: true, account_revision: '9007199254740999' }, error: null });
  state.cached.mockReset().mockResolvedValue('device');
  state.agent.mockReset().mockResolvedValue({ gugu_user_id: 'agent' });
});
const setup = (getAuth = async () => auth) => {
  const resolveDeviceId = vi.fn(async () => 'device');
  const ensureAgentAddress = vi.fn(async () => ({ chatId: 'chat', agentUserId: 'agent' }));
  return { resolveDeviceId, ensureAgentAddress, transport: createNativePublicationTransport({ getAuth, resolveDeviceId, ensureAgentAddress, env: {} }) };
};
it('captures the owner-scoped cached identity without a network registration during offline admission', async () => {
  const { transport, resolveDeviceId } = setup();
  expect(await transport.context('session')).toEqual({ ownerUserId: 'owner', deviceId: 'device', agentUserId: 'agent' });
  expect(state.cached).toHaveBeenCalledWith({}, 'owner');
  expect(resolveDeviceId).not.toHaveBeenCalled();
});
it('uses the exact persisted publication tuple and keeps decimal revisions as strings', async () => {
  const { transport } = setup();
  expect(await transport.publish(entry)).toEqual({ already: true, accountRevision: '9007199254740999' });
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith('publish_native_conversation_message', {
    p_device_id: 'device', p_agent_user_id: 'agent', p_session_id: 'session', p_message_id: 'publication', p_chat_id: 'chat', p_occurred_at: entry.occurredAt,
  });
});
it('refuses another account or a restored Agent binding before sending an old publication', async () => {
  const { transport } = setup(async () => ({ ...auth, userId: 'another' }));
  await expect(transport.publish(entry)).rejects.toThrow('owner or binding changed');
  const original = setup().transport;
  state.agent.mockResolvedValue({ gugu_user_id: 'new-agent' });
  await expect(original.publish(entry)).rejects.toThrow('owner or binding changed');
  expect(state.rpc).not.toHaveBeenCalled();
});
it('refuses an account switch during the asynchronous capture and a malformed receipt', async () => {
  let reads = 0;
  const { transport } = setup(async () => (++reads === 1 ? auth : { ...auth, userId: 'another' }));
  await expect(transport.context('session')).rejects.toThrow('account changed during admission');
  state.rpc.mockResolvedValue({ data: { chat_id: 'chat', already: true, account_revision: 42 }, error: null });
  await expect(setup().transport.publish(entry)).rejects.toThrow('Invalid native publication receipt');
});
