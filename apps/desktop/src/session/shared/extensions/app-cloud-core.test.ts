import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn(async (..._args: unknown[]): Promise<{ data: unknown; error: { message: string } | null }> => ({ data: 'answer', error: null }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));

const { createAppCloud } = await import('./app-cloud-core');

const channel = vi.fn((_topic: string, _event: string, _onPayload: (payload: Record<string, unknown>) => void, onSubscribed: () => void) => {
  onSubscribed();
  return () => undefined;
});
const cloud = createAppCloud({ account: async () => ({ token: 't' }), channel });
const market = { id: 'data-lens', origin: 'market' as const };

beforeEach(() => vi.clearAllMocks());

describe('gugu.cloud: an App reaches only its own part of the cloud', () => {
  it('a read goes over GET, with what is null left to the function default', async () => {
    await expect(cloud.read(market, 'data_lens_list', { p_query: null, p_limit: 3 })).resolves.toBe('answer');
    expect(rpc).toHaveBeenCalledWith('data_lens_list', { p_limit: 3 }, { get: true });
  });

  it('a write goes through as asked, and the database reason is the message', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'too_new' } });
    await expect(cloud.write(market, 'data_lens_save', { p_as: null })).rejects.toMatchObject({ code: 'failed', message: 'too_new' });
    expect(rpc).toHaveBeenCalledWith('data_lens_save', { p_as: null });
  });

  it.each(['open_dm', 'data_lens', 'datalens_list', 'other_list', 'data_lens_list; drop', 'DATA_LENS_LIST'])('another function is refused: %s', async (name) => {
    await expect(cloud.read(market, name)).rejects.toMatchObject({ code: expect.stringMatching(/denied|invalid/) });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['folder', 'attachment', 'fork', undefined] as const)('an App whose id nobody reviewed has none: %s', async (origin) => {
    const app = { id: 'data-lens', origin };
    await expect(cloud.write(app, 'data_lens_save')).rejects.toMatchObject({ code: 'denied' });
    expect(() => cloud.watch(app, 'gugu:data-lens:feed', 'changed', () => undefined)).toThrow(/market/);
    expect(rpc).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
  });

  it('one shipped with gugu has one', async () => {
    await expect(cloud.read({ id: 'workspace', origin: 'preinstalled' }, 'workspace_list')).resolves.toBe('answer');
  });

  it('hears only its own topics, and says each (re)subscription', () => {
    const heard: unknown[] = [];
    cloud.watch(market, 'gugu:data-lens:feed', 'changed', (one) => heard.push(one));
    expect(heard).toEqual([{ subscribed: true }]);
    channel.mock.calls[0]![2]({ kind: 'x' });
    expect(heard[1]).toEqual({ payload: { kind: 'x' } });
    for (const topic of ['gugu:other:feed', 'gugu:data-lens:', 'data-lens:feed']) {
      expect(() => cloud.watch(market, topic, 'changed', () => undefined)).toThrow(/may hear only/);
    }
  });
});
