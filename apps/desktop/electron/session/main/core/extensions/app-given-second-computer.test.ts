import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { HERE_ALL } from '@shared/extensions/host-actions';
import type { AppIdentity } from '@shared/extensions/app-identity';
import { ExtensionsService } from './extensions-service';

/**
 * App architecture §4 (owner 10-27): who may use an App is two layers — this computer's half (every agent here, or not), kept
 * with the install, and the account's rows at chats, shared by every computer of the owner. An install writes this computer's
 * half only; the App page changes the rows one at a time. Two install roots stand for two computers, sharing one table.
 */
const state = vi.hoisted(() => ({
  service: null as unknown as ExtensionsService,
  rows: [] as Array<{ chatId: string; userId: string; app: { publisher: string; id: string } }>,
  unread: null as Error | null,
}));

vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => state.service, appSourcesRoot: () => path.join(work, 'app-sources') }));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()),
  // A signed-in account: the access token's subject is owner-1.
  currentAccountAccessToken: async () => `h.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.s`,
}));
vi.mock('./app-files', () => ({ folderPublisher: async () => ({ id: 'owner-1' }) }));
vi.mock('../../../../sessionpage/sessionpage-project-groups', () => ({ listProjectGroupIds: async () => [] }));
vi.mock('@shared/extensions/app-enablements-core', () => ({
  readEnablements: async (_token: string, userId: string, chatIds?: readonly string[]) => {
    if (state.unread) throw state.unread;
    return state.rows.filter((row) => row.userId === userId && (!chatIds || chatIds.includes(row.chatId)));
  },
  setEnablement: async (_token: string, userId: string, chatId: string, app: AppIdentity, on: boolean) => {
    state.rows = state.rows.filter((row) => !(row.userId === userId && row.chatId === chatId && row.app.publisher === app.publisher && row.app.id === app.id));
    if (on) state.rows.push({ chatId, userId, app: { ...app } });
  },
  enablementChatOf: async (_token: string, chatId: string) => (['g', 'h'].includes(chatId) ? { id: chatId, name: chatId.toUpperCase() } : null),
}));
// The owner's chats: groups G and H (owner-1 and their agent in each).
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => ({
      select: () => {
        const rows = (): unknown[] => {
          if (table === 'chats') {
            return ['g', 'h'].map((id) => ({ id, kind: 'group', status: 'active', name: id.toUpperCase(), avatar_url: null, last_message_at: null, source_chat_id: null }));
          }
          if (table === 'chat_members') return ['g', 'h'].flatMap((id) => [{ chat_id: id, user_id: 'owner-1' }, { chat_id: id, user_id: 'agent-1' }]);
          return [];
        };
        return { eq: async () => ({ data: rows(), error: null }), in: async () => ({ data: rows(), error: null }) };
      },
    }),
  }),
}));

// installPrepared tells the window and applies the App through these; the window is not here.
vi.mock('./extension-bridge-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extension-bridge-relay')>()),
  announceInstalledChanged: async () => 'shown',
}));

const given = await import('./app-given');
const { installPrepared } = await import('./install-prepared');
const work = mkdtempSync(path.join(tmpdir(), 'gugu-app-given-second-'));

function source(): string {
  const dir = path.join(work, `source-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<p>search</p>');
  writeFileSync(path.join(dir, 'tools.js'), 'export const search = { description: "Search", inputSchema: { type: "object" }, run: () => "" };');
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'searcher', name: 'Searcher', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: ['agents:tools'] },
    contributes: { tabs: [{ name: 'main', title: 'Searcher' }], mcpServers: [{ tools: 'tools.js' }] },
  }));
  return dir;
}

/** One computer: its own install root. */
function computer(): ExtensionsService {
  return new ExtensionsService(path.join(work, `installed-${Math.random().toString(36).slice(2)}`));
}

const APP = { publisher: 'owner-1', id: 'searcher' };
const chats = () => state.rows.map((row) => row.chatId).sort();

/** One install of the folder App on `service`, the one way every install goes (installPrepared), confirmed as asked. */
async function install(service: ExtensionsService, options: { chatId?: string; consent?: 'given' } = {}) {
  state.service = service;
  const dir = source();
  const { manifest, manifestDigest } = service.inspectDirectory(dir);
  const first = !service.list().extensions.some((one) => one.manifest.id === 'searcher');
  const asked: unknown[] = [];
  const result = await installPrepared(
    { dir, manifest, manifestDigest, origin: 'folder', publisher: { id: 'owner-1' }, asks: false, sheet: { revokedPermissions: [] },
      places: { first, chatId: options.chatId, identity: APP } },
    options.consent ? { kind: 'given', digest: manifestDigest } : { kind: 'here' },
    { requestInstallConsent: async (request) => { asked.push(request.given ?? null); return { outcome: 'confirmed' }; }, afterInstall: () => {}, notifyInstalledChanged: async () => {} },
  );
  return { result, asked };
}

describe('an install writes this computer\'s half only (architecture §4.2: problems 1, 2, 10, 16)', () => {
  beforeEach(() => {
    state.rows = [];
    state.unread = null;
  });

  it('a first install gives every agent here and leaves the account\'s rows exactly as they were', async () => {
    state.rows = [{ chatId: 'g', userId: 'owner-1', app: APP }, { chatId: 'h', userId: 'owner-1', app: APP }];
    const second = computer();
    const { asked } = await install(second);
    expect(asked).toEqual([{ first: true }]);
    expect(second.givenHere(APP)).toEqual([HERE_ALL]);
    expect(chats()).toEqual(['g', 'h']);
  });

  it('I3: a computer ticked in 「也装到」 (installed with the digest alone) gets the same rule — every agent there — and writes no row', async () => {
    state.rows = [{ chatId: 'g', userId: 'owner-1', app: APP }];
    const other = computer();
    const { result } = await install(other, { consent: 'given' });
    expect(result.outcome).toBe('confirmed');
    expect(other.givenHere(APP)).toEqual([HERE_ALL]);
    expect(chats()).toEqual(['g']);
  });

  it('a first install works with the account unreadable (offline): it reads nothing of the account', async () => {
    state.unread = new Error('offline');
    const here = computer();
    const { result } = await install(here);
    expect(result.outcome).toBe('confirmed');
    expect(here.givenHere(APP)).toEqual([HERE_ALL]);
  });

  it('a first install from a chat (a card, an agent installing for it) gives every agent here, not a row for that chat (编号 2)', async () => {
    const here = computer();
    await install(here, { chatId: 'g' });
    expect(here.givenHere(APP)).toEqual([HERE_ALL]);
    expect(state.rows).toEqual([]);
  });

  it('installed again for a chat where this computer is narrowed: adds that one row, takes nothing away, widens nothing here', async () => {
    const here = computer();
    await install(here);
    state.service = here;
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: false }, { id: 'g', on: true }]);
    const { asked } = await install(here, { chatId: 'h' });
    expect(asked).toEqual([{ first: false, chat: { id: 'h', name: 'H' } }]);
    expect(chats()).toEqual(['g', 'h']);
    expect(here.givenHere(APP)).toEqual([]);
  });

  it('installed again changes nothing — and asks nothing — for a chat given already, for no chat, a chat that is no place, or where every agent here has it', async () => {
    const here = computer();
    await install(here);
    state.service = here;
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: false }, { id: 'g', on: true }]);
    for (const chatId of ['g', undefined, 'not-a-place']) expect((await install(here, { chatId })).asked).toEqual([]);
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: true }]);
    expect((await install(here, { chatId: 'h' })).asked).toEqual([]);
    expect(chats()).toEqual(['g']);
  });

  it('the chat row failing to be written does not fail the install (this computer\'s half decides here)', async () => {
    const here = computer();
    await install(here);
    state.service = here;
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: false }]);
    const enablements = await import('@shared/extensions/app-enablements-core');
    const write = vi.spyOn(enablements, 'setEnablement').mockRejectedValueOnce(new Error('network'));
    const { result } = await install(here, { chatId: 'h' });
    expect(result.outcome).toBe('confirmed');
    write.mockRestore();
  });
});

describe('I9: the App page changes one place at a time — never the whole set written back', () => {
  beforeEach(() => {
    state.rows = [];
    state.unread = null;
  });

  it('a change made on one computer is not taken away by another computer\'s change made from an older snapshot', async () => {
    const one = computer(), two = computer();
    await install(one);
    await install(two);
    // Computer two gives group H; computer one, its panel read before that, turns every agent there off.
    state.service = two;
    await given.changeAppPlaces('searcher', [{ id: 'h', on: true }]);
    state.service = one;
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: false }]);
    expect(chats()).toEqual(['h']);
    expect(one.givenHere(APP)).toEqual([]);
    expect(two.givenHere(APP)).toEqual([HERE_ALL]);
  });
});

// #6981 × #6976: an agent's app_install for a chat the App is not given at, on a computer where it is narrowed, goes to the
// person (the sheet says which chat it adds); for a chat it is given at already, it installs quietly.
describe('app_install of the same folder App for a chat it is not given at shows the sheet', () => {
  beforeEach(() => {
    state.rows = [];
    state.unread = null;
  });

  it('asks for chat h, naming it; stays quiet for chat g where it is given already', async () => {
    const here = computer();
    await install(here);
    state.service = here;
    await given.changeAppPlaces('searcher', [{ id: HERE_ALL, on: false }, { id: 'g', on: true }]);
    const { runExtensionAgentAction } = await import('./extension-agent-actions');
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    const dependencies = { requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() };

    await expect(runExtensionAgentAction({ action: 'install', source_dir: source(), chat_id: 'h' }, dependencies))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(requestInstallConsent.mock.calls[0]![0].given).toEqual({ first: false, chat: { id: 'h', name: 'H' } });

    await expect(runExtensionAgentAction({ action: 'install', source_dir: source(), chat_id: 'g' }, dependencies))
      .resolves.toMatchObject({ installed: true });
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
  });
});

// 主人 10-16: a computer still keeping the removed 「agents in no project」 place (`here:projectless`) gives nobody anything by it.
describe('a computer that kept only the removed 「agents in no project」', () => {
  beforeEach(() => {
    state.rows = [];
    state.unread = null;
  });

  it('shows the App given to nobody, and installing it again for a chat adds that chat and widens nothing here', async () => {
    const root = path.join(work, `installed-${Math.random().toString(36).slice(2)}`);
    const here = new ExtensionsService(root);
    await install(here);
    writeFileSync(path.join(root, '.given-here.json'), JSON.stringify({ 'owner-1/searcher': ['here:projectless'] }));
    state.service = here;
    expect((await given.appPlaces('searcher')).filter((place) => place.enabled)).toEqual([]);
    await install(here, { chatId: 'h' });
    expect(here.givenHere(APP)).toEqual(['here:projectless']);
    expect(chats()).toEqual(['h']);
  });
});

afterEach(() => {
  state.unread = null;
});
