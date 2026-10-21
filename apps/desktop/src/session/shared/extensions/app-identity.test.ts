import { describe, expect, it } from 'vitest';
import { appIdentityOf, appKey, publisherOf, type PublisherAccount } from './app-identity';

const ALICE = '0a000000-0000-4000-8000-00000000000a';
const ALICE_AGENT = '0c000000-0000-4000-8000-00000000000c';
const LONE_AGENT = '0d000000-0000-4000-8000-00000000000d';

const accounts: Record<string, PublisherAccount> = {
  [ALICE]: { type: 'human', owner_user_id: null, display_name: 'Alice' },
  [ALICE_AGENT]: { type: 'agent', owner_user_id: ALICE, display_name: 'Claude 3' },
  [LONE_AGENT]: { type: 'agent', owner_user_id: null, display_name: 'Lone' },
};
const readAccount = async (id: string) => accounts[id] ?? null;

describe('appIdentityOf: who published it and its id, never its version', () => {
  const manifest = { id: 'trip-vote' };

  it('preinstalled and market Apps are gugu’s, whatever is on record', () => {
    expect(appIdentityOf({ manifest, origin: 'preinstalled', publisher: null })).toEqual({ publisher: 'gugu', id: 'trip-vote' });
    expect(appIdentityOf({ manifest, origin: 'market', publisher: { id: ALICE } })).toEqual({ publisher: 'gugu', id: 'trip-vote' });
  });

  it('a card’s or a folder’s App is the publisher on record', () => {
    expect(appIdentityOf({ manifest, origin: 'attachment', publisher: { id: ALICE } })).toEqual({ publisher: ALICE, id: 'trip-vote' });
    expect(appIdentityOf({ manifest, origin: 'folder', publisher: { id: ALICE } })).toEqual({ publisher: ALICE, id: 'trip-vote' });
  });

  it('with nothing on record there is no identity — never the account signed in now', () => {
    expect(appIdentityOf({ manifest, origin: 'folder', publisher: null })).toBeNull();
    expect(appIdentityOf({ manifest, origin: undefined, publisher: undefined })).toBeNull();
  });

  it('appKey spells it <publisher>/<id>', () => {
    expect(appKey({ publisher: 'gugu', id: 'workspace' })).toBe('gugu/workspace');
  });
});

describe('publisherOf: the person behind the account that uploaded a package', () => {
  it('a person is themselves', async () => {
    await expect(publisherOf(readAccount, ALICE)).resolves.toEqual({ id: ALICE, name: 'Alice' });
  });

  it('an agent’s upload is its owner’s, under the owner’s name', async () => {
    await expect(publisherOf(readAccount, ALICE_AGENT)).resolves.toEqual({ id: ALICE, name: 'Alice' });
  });

  it('an agent with no owner is its own publisher', async () => {
    await expect(publisherOf(readAccount, LONE_AGENT)).resolves.toEqual({ id: LONE_AGENT, name: 'Lone' });
  });

  it('an account that is not there is refused', async () => {
    await expect(publisherOf(readAccount, '0e000000-0000-4000-8000-00000000000e')).rejects.toThrow('No account');
  });
});
