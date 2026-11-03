import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ kind: 'dm', readError: null as {message:string} | null,
  reply: {data: {chat_id:'dm',deleted_at:'2026-11-03T03:48:01Z'} as unknown,error:null as {message:string} | null},
  archive: vi.fn(), rpc: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn() }));
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { from: state.from, rpc: state.rpc } }));
vi.mock('../../../../apps/desktop/src/lib/groupAdmin', () => ({ currentGroupAdmin: async () => ({archive:state.archive}) }));
import { deleteListedConversation } from '../../../../apps/desktop/src/lib/deleteListedConversation';
beforeEach(() => {
  vi.clearAllMocks(); state.kind='dm'; state.readError=null; state.reply={data:{chat_id:'dm',deleted_at:'2026-11-03T03:48:01Z'},error:null};
  state.from.mockReturnValue({select:state.select}); state.select.mockReturnValue({eq:state.eq}); state.eq.mockReturnValue({single:state.single});
  state.single.mockImplementation(async () => ({data:{kind:state.kind},error:state.readError})); state.rpc.mockImplementation(async () => state.reply);
});
it('uses the personal DM RPC and never the group archive path', async () => {
  await deleteListedConversation('dm');
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith('delete_my_dm_conversation',{p_chat_id:'dm'});
  expect(state.archive).not.toHaveBeenCalled();
});
it('requires the persisted deletion receipt before the caller removes its row', async () => {
  state.reply.data={chat_id:'somewhere-else',deleted_at:'2026-11-03T03:48:01Z'};
  await expect(deleteListedConversation('dm')).rejects.toThrow('Conversation deletion was not confirmed');
});
it('preserves active-agent denial so the row stays and the UI explains why', async () => {
  state.reply.error={message:'conversation_agent_in_use'};
  await expect(deleteListedConversation('dm')).rejects.toThrow('conversation_agent_in_use');
  expect(state.archive).not.toHaveBeenCalled();
});
it('keeps group deletion on its existing management RPC', async () => {
  state.kind='group'; await deleteListedConversation('group');
  expect(state.archive).toHaveBeenCalledExactlyOnceWith('group'); expect(state.rpc).not.toHaveBeenCalled();
});
it('does not mutate after a failed kind read or for an unsupported conversation kind', async () => {
  state.readError={message:'permission denied'}; await expect(deleteListedConversation('dm')).rejects.toThrow('permission denied');
  state.readError=null; state.kind='ai'; await expect(deleteListedConversation('dm')).rejects.toThrow('conversation_dm_identity_unverified');
  expect(state.rpc).not.toHaveBeenCalled(); expect(state.archive).not.toHaveBeenCalled();
});
