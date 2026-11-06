import { describe, expect, it } from 'vitest';
import type { DisplayIdentity } from '@/lib/displayIdentity';
import type { IdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { chatActor } from './actor-identity';

const human = '11111111-1111-4111-8111-111111111111', agent = '22222222-2222-4222-8222-222222222222';
const identity = (id: string, type: 'agent' | 'human', number: number): DisplayIdentity => ({
  id, type, display_name: type, nameSerial: null, avatar: null, gugu_number: number, bio: null, owner_user_id: null,
  agent_public: null, desired_status: null, device_id: null, category: null, is_official: null, local_path: null, created_at: null, updated_at: null,
});
const ensured: string[][] = [];
const bridge: IdentityDirectoryBridge = { getSnapshot: () => ({ [human]: identity(human, 'human', 10), [agent]: identity(agent, 'agent', 20) }),
  ensure: ids => ensured.push([...ids]), subscribe: () => () => {} };

describe('host activity identity', () => {
  it('uses the same typed identity for user, Agent ID alias and public number', () => {
    const result = { id: `user:${agent}`, type: 'agent', name: 'agent' };
    for (const address of [`user:${agent}`, `aid:${agent}`, 'gugu:20']) expect(chatActor(address, bridge)).toEqual(result);
    expect(chatActor('gugu:10', bridge)?.type).toBe('human');
  });
  it('uses the actual session owner when known and preserves the session identity otherwise', () => {
    expect(chatActor('session:local', bridge, () => agent)?.id).toBe(`user:${agent}`);
    const session = 'session:505adac7-1905-473b-8d2f-d574b6892518';
    expect(chatActor(session, bridge, () => undefined)).toEqual({ id: session, type: 'agent', name: '' });
    expect(chatActor('session:unknown', bridge, () => undefined)).toBeNull();
  });
  it('keeps unknown/malformed/system addresses unclassified without throwing', () => {
    for (const address of ['user:', 'session:', 'gugu:0', 'gugu:NaN', 'system:gugu', agent]) expect(chatActor(address, bridge)).toBeNull();
    expect(chatActor('user:unknown', bridge)).toBeNull();
    expect(ensured).toContainEqual(['unknown']);
  });
});
