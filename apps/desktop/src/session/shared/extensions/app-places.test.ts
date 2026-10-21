import { describe, expect, it } from 'vitest';
import { applyPlaceChanges, placesOfChats, type PlaceChat } from './app-places';
import { HERE_ALL } from './host-actions';

/**
 * D-30 「给哪些 agent」 (主人 10-02 方案 A, 125 10-06 the fifth): the places as the picker lists them — this computer's agents,
 * the person's own agents by their private chats, then active groups as the chat list draws them.
 */
const chat = (over: Partial<PlaceChat> & Pick<PlaceChat, 'id' | 'kind'>): PlaceChat => ({
  status: 'active',
  name: '',
  avatar: null,
  member_user_ids: [],
  last_message_at: null,
  source_chat_id: null,
  peer_user_id: null,
  ...over,
});

const identities = {
  me: { display_name: 'Me' },
  helper: { display_name: '周报助手', avatar: 'https://x/h.png', agentOf: 'me' },
  theirs: { display_name: 'Someone else’s agent', agentOf: 'friend' },
  friend: { display_name: 'Friend' },
};

describe('the places an App can be given at (D-30)', () => {
  const chats = [
    chat({ id: 'dm-helper', kind: 'dm', peer_user_id: 'helper', member_user_ids: ['me', 'helper'], last_message_at: '2026-10-06T08:00:00Z' }),
    chat({ id: 'dm-friend', kind: 'dm', peer_user_id: 'friend', member_user_ids: ['me', 'friend'] }),
    chat({ id: 'dm-theirs', kind: 'dm', member_user_ids: ['me', 'theirs'] }),
    chat({ id: 'g1', kind: 'group', name: '周末出游', member_user_ids: ['me', 'friend', 'helper'] }),
    chat({ id: 't1', kind: 'topic', name: '路线', source_chat_id: 'g1' }),
    chat({ id: 'g-gone', kind: 'group', name: 'old', status: 'archived' }),
  ];

  it("lists this computer's agents first, then the person's own agents by their private chat, then active groups", () => {
    const places = placesOfChats(chats, identities, { me: 'me', enabled: new Set([HERE_ALL, 'dm-helper']), projects: new Set(['g1']), here: true });
    expect(places.map((place) => [place.kind, place.id, place.enabled])).toEqual([
      ['here', HERE_ALL, true],
      ['agent', 'dm-helper', true],
      ['group', 'g1', false],
    ]);
    // Shown as the agent — its face and name — never as "the private chat with it".
    expect(places[1]).toMatchObject({ name: '周报助手', avatar: 'https://x/h.png', agentId: 'helper' });
    expect(places[2]).toMatchObject({ name: '周末出游', project: true, memberCount: 3, topics: ['路线'] });
    expect(places[2]!.members?.map((member) => member.id)).toEqual(['me', 'friend', 'helper']);
  });

  it('a phone lists no computer of its own; a human friend and someone else’s agent are no agents of the person', () => {
    const places = placesOfChats(chats, identities, { me: 'me', enabled: new Set() });
    expect(places.map((place) => place.id)).toEqual(['dm-helper', 'g1']);
  });

  it('switches add and remove, each at most once', () => {
    expect(applyPlaceChanges([HERE_ALL], [{ id: 'g1', on: true }, { id: 'g1', on: true }, { id: HERE_ALL, on: false }])).toEqual(['g1']);
  });
});
