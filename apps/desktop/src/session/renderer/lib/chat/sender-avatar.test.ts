import { describe, expect, it } from 'vitest';
import { dicebearAvatarDataUri, displayAvatarUrl } from '@/lib/dicebearAvatar';
import type { DisplayIdentity } from '@/lib/displayIdentity';
import type { IdentityDirectoryBridge, IdentityDirectorySnapshot } from '@/lib/identityDirectoryBridge';
import { senderAvatarUrl } from './sender-avatar';

// #6306 投递卡头像 = 聊天页同一份身份缓存、同一个投影。
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const PHOTO = 'https://example.test/avatars/alice.png';

function identity(id: string, avatar: string | null, type: 'human' | 'agent' = 'human'): DisplayIdentity {
  return {
    id, type, display_name: id.slice(0, 4), avatar, gugu_number: null, bio: null, owner_user_id: null,
    agent_public: null, desired_status: null, device_id: null, category: null, is_official: null, local_path: null,
    created_at: null, updated_at: null,
  };
}

function bridge(snapshot: IdentityDirectorySnapshot | null) {
  const ensured: string[][] = [];
  const b: IdentityDirectoryBridge = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    ensure: (ids) => { ensured.push([...ids]); },
  };
  return { b, ensured };
}

describe('senderAvatarUrl (#6306)', () => {
  const cache = { [ALICE]: identity(ALICE, PHOTO), [BOB]: identity(BOB, null) };

  it('an uploaded avatar is drawn as-is', () => {
    expect(senderAvatarUrl(`user:${ALICE}`, bridge(cache).b)).toBe(PHOTO);
  });

  it('no upload ⇒ the same generated face the chat page draws for that id', () => {
    expect(senderAvatarUrl(`user:${BOB}`, bridge(cache).b)).toBe(dicebearAvatarDataUri(BOB));
  });

  // agent 没上传头像:默认脸是咕咕小鸟的静态定格(会动的那只只在聊天 / 手机的 <Avatar> 里);上传了的仍逐字用那张。
  it('an agent with no upload is drawn as the bird (the default face of every agent), an upload is still as-is', () => {
    const agents = { [ALICE]: identity(ALICE, PHOTO, 'agent'), [BOB]: identity(BOB, null, 'agent') };
    const bird = displayAvatarUrl(null, BOB, 'test', 'agent');
    expect(bird).not.toBe(dicebearAvatarDataUri(BOB));
    expect(senderAvatarUrl(`user:${BOB}`, bridge(agents).b)).toBe(bird);
    expect(senderAvatarUrl(`user:${ALICE}`, bridge(agents).b)).toBe(PHOTO);
  });

  it('not in the cache yet ⇒ nothing drawn, and the cache is asked for it', () => {
    const { b, ensured } = bridge(cache);
    const stranger = '33333333-3333-4333-8333-333333333333';
    expect(senderAvatarUrl(`user:${stranger}`, b)).toBeNull();
    expect(ensured).toEqual([[stranger]]);
  });

  it('cache not open yet ⇒ nothing drawn, still asks', () => {
    const { b, ensured } = bridge(null);
    expect(senderAvatarUrl(`user:${ALICE}`, b)).toBeNull();
    expect(ensured).toEqual([[ALICE]]);
  });

  it('senders without an identity (system: / none) get no avatar and ask nothing', () => {
    const { b, ensured } = bridge(cache);
    expect(senderAvatarUrl('system:gugu', b, () => ALICE)).toBeNull();
    expect(senderAvatarUrl(null, b, () => ALICE)).toBeNull();
    expect(ensured).toEqual([]);
  });

  // 「来自会话」两条腿同一个人:graph 寻址的 session:<id> 画这条会话的属主 agent,与 roster 寻址的 user:<agent> 一模一样。
  it('session:<id> is drawn as the agent that owns that session — the same face as user:<agent>', () => {
    const owners: Record<string, string> = { 'conv-1': ALICE, 'conv-2': BOB };
    const ownerOf = (sessionId: string) => owners[sessionId];
    const agents = { [ALICE]: identity(ALICE, PHOTO, 'agent'), [BOB]: identity(BOB, null, 'agent') };
    expect(senderAvatarUrl('session:conv-1', bridge(agents).b, ownerOf)).toBe(senderAvatarUrl(`user:${ALICE}`, bridge(agents).b));
    expect(senderAvatarUrl('session:conv-2', bridge(agents).b, ownerOf)).toBe(displayAvatarUrl(null, BOB, 'test', 'agent'));
    // 属主一定是 agent:就算身份缓存里的 type 暂时缺 / 写成别的,会话那一腿也按 agent 画。
    expect(senderAvatarUrl('session:conv-2', bridge(cache).b, ownerOf)).toBe(displayAvatarUrl(null, BOB, 'test', 'agent'));
  });

  it('a session with no owning agent (never provisioned / reaped) draws nothing and asks nothing', () => {
    const { b, ensured } = bridge(cache);
    expect(senderAvatarUrl('session:gone', b, () => undefined)).toBeNull();
    expect(ensured).toEqual([]);
  });

  it('a session whose owner is not cached yet asks the cache for the owner, like any user sender', () => {
    const { b, ensured } = bridge(cache);
    const stranger = '33333333-3333-4333-8333-333333333333';
    expect(senderAvatarUrl('session:conv-9', b, () => stranger)).toBeNull();
    expect(ensured).toEqual([[stranger]]);
  });

  it('no bridge (task page opened standalone) ⇒ nothing drawn', () => {
    expect(senderAvatarUrl(`user:${ALICE}`, undefined)).toBeNull();
  });
});
