import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { HERE_ALL } from '@shared/extensions/host-actions';
import type { AppIdentity } from '@shared/extensions/app-identity';
import { ExtensionsService } from './extensions-service';

/**
 * 复核 72 (125 10-07): 「给哪些 agent」 is the account's — every computer of the owner reads the same rows. An App's first install
 * on a second computer is not the account's first: its sheet shows the chats the owner gave it at from the first computer
 * ticked, and its answer (written back whole) keeps them. Two install roots stand for the two computers, sharing one table.
 */
const state = vi.hoisted(() => ({
  service: null as unknown as ExtensionsService,
  rows: [] as Array<{ chatId: string; userId: string; app: { publisher: string; id: string } }>,
  unread: null as Error | null,
}));

vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => state.service }));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()),
  // A signed-in account: the access token's subject is owner-1.
  currentAccountAccessToken: async () => `h.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.s`,
}));
vi.mock('./app-files', () => ({ folderPublisher: async () => ({ id: 'owner-1' }) }));
vi.mock('../../../../sessionpage/sessionpage-project-groups', () => ({ listProjectGroupIds: async () => [] }));
vi.mock('@shared/extensions/app-enablements-core', () => ({
  readEnablements: async (_token: string, userId: string) => {
    if (state.unread) throw state.unread;
    return state.rows.filter((row) => row.userId === userId);
  },
  setEnablement: async (_token: string, userId: string, chatId: string, app: AppIdentity, on: boolean) => {
    state.rows = state.rows.filter((row) => !(row.userId === userId && row.chatId === chatId && row.app.publisher === app.publisher && row.app.id === app.id));
    if (on) state.rows.push({ chatId, userId, app: { ...app } });
  },
  enablementChatOf: async (_token: string, chatId: string) => chatId,
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

/** An install from a folder on this computer, as the agent's `app_install` does it: asked, installed, recorded. */
async function installHere(service: ExtensionsService, answer?: (ask: { places: { id: string; enabled: boolean }[] }) => string[], chatId?: string) {
  state.service = service;
  const dir = source();
  const inspected = service.inspectDirectory(dir);
  const asked = await given.installAsk(inspected.manifest, !service.list().extensions.some((one) => one.manifest.id === 'searcher'), chatId, await given.ownInstallIdentity('searcher', 'folder'));
  service.installFromDirectory(dir, inspected.manifestDigest, 'folder', { id: 'owner-1' });
  await given.recordGiven('searcher', asked, asked && answer ? answer(asked) : undefined);
  return asked;
}

describe('an App given at chats from one computer, installed first on another (复核 72)', () => {
  beforeEach(() => {
    state.rows = [];
  });

  it('the second computer asks with those chats ticked, and its default answer keeps them', async () => {
    const a = computer();
    await installHere(a);
    state.service = a;
    await given.setAppPlaces('searcher', [HERE_ALL, 'g']);
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);

    const asked = await installHere(computer());
    expect(asked?.places.find((place) => place.id === 'g')?.enabled).toBe(true);
    expect(asked?.places.find((place) => place.id === 'h')?.enabled).toBe(false);
    expect(asked?.ticks).toEqual([HERE_ALL, 'g']);
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);
  });

  it('a chat the person unticks on the second computer is theirs to drop', async () => {
    const a = computer();
    await installHere(a);
    state.service = a;
    await given.setAppPlaces('searcher', [HERE_ALL, 'g', 'h']);

    await installHere(computer(), (ask) => ask.places.filter((place) => place.enabled && place.id !== 'h').map((place) => place.id));
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);
  });

  it("another publisher's App under the same id is not that App: nothing of the first one's is ticked", async () => {
    state.rows = [{ chatId: 'g', userId: 'owner-1', app: { publisher: 'someone-else', id: 'searcher' } }];
    const asked = await installHere(computer());
    expect(asked?.places.find((place) => place.id === 'g')?.enabled).toBe(false);
    expect(state.rows).toEqual([{ chatId: 'g', userId: 'owner-1', app: { publisher: 'someone-else', id: 'searcher' } }]);
  });

  it('app_install { device }: the machine it lands on asks with them ticked, and the answer the person gave elsewhere keeps them', async () => {
    // D-31 two-step (extension-attachment-install): that machine inspects the package and returns its ask — the places as it
    // lists them — the person answers on their own screen, and it installs with that answer.
    state.rows = [{ chatId: 'g', userId: 'owner-1', app: { publisher: 'owner-1', id: 'searcher' } }];
    state.service = computer();
    const dir = source();
    const { manifest, manifestDigest } = state.service.inspectDirectory(dir);
    const ask = await given.installAsk(manifest, true, undefined, { publisher: 'owner-1', id: 'searcher' }, true);
    expect(ask?.places.find((place) => place.id === 'g')?.enabled).toBe(true);
    const answer = ask!.places.filter((place) => place.enabled).map((place) => place.id);
    state.service.installFromDirectory(dir, manifestDigest, 'attachment', { id: 'owner-1' });
    await given.recordGiven('searcher', ask, answer);
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);
  });
});

// 编号 2 (10-12 片场试演): 片场 was installed first from a card in one group, ticked for that group only, and the agents of the
// next group had nothing. D-30「没选过的 App 给本机所有 agent」: a first install ticks every agent here, wherever it comes from.
describe('a first install from a chat — a card, an agent installing for it — ticks every agent here, not that chat (编号 2)', () => {
  beforeEach(() => {
    state.rows = [];
  });

  it('every agent here ticked, the chat not ticked nor marked; confirmed as asked, no chat row is written', async () => {
    state.service = computer();
    const dir = source();
    const { manifest, manifestDigest } = state.service.inspectDirectory(dir);
    const asked = await given.installAsk(manifest, true, 'g', { publisher: 'owner-1', id: 'searcher' }, true);
    expect(asked?.ticks).toEqual([HERE_ALL]);
    expect(asked?.places.find((place) => place.id === 'g')).toMatchObject({ enabled: false });
    expect(asked?.places.some((place) => place.card)).toBe(false);
    state.service.installFromDirectory(dir, manifestDigest, 'attachment', { id: 'owner-1' });
    await given.recordGiven('searcher', asked, undefined);
    expect(state.service.givenHere({ publisher: 'owner-1', id: 'searcher' })).toEqual([HERE_ALL]);
    expect(state.rows).toEqual([]);
  });
});

describe('an App installed here already, installed again for a chat it is not given at (125 10-07)', () => {
  beforeEach(() => {
    state.rows = [];
  });

  it('asks, with the new chat ticked and what the person chose kept', async () => {
    const here = computer();
    await installHere(here);
    await given.setAppPlaces('searcher', ['g']);

    const asked = await installHere(here, undefined, 'h');
    expect(asked?.ticks.sort()).toEqual(['g', 'h']);
    expect(asked?.places.find((place) => place.id === 'h')?.enabled).toBe(true);
    expect(asked?.places.find((place) => place.id === 'g')?.enabled).toBe(true);
    expect(state.rows.map((row) => row.chatId).sort()).toEqual(['g', 'h']);
    expect(here.givenHere({ publisher: 'owner-1', id: 'searcher' })).toEqual([]);
  });

  it('the person unticking the new chat leaves things as they were', async () => {
    const here = computer();
    await installHere(here);
    await given.setAppPlaces('searcher', ['g']);
    await installHere(here, (ask) => ask.places.filter((place) => place.enabled && place.id !== 'h').map((place) => place.id), 'h');
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);
  });

  it('asks nothing for a chat it is given at, for no chat, or when it reaches every agent here', async () => {
    const here = computer();
    await installHere(here);
    await given.setAppPlaces('searcher', ['g']);
    expect(await installHere(here, undefined, 'g')).toBeNull();
    expect(await installHere(here)).toBeNull();

    await given.setAppPlaces('searcher', [HERE_ALL]);
    expect(await installHere(here, undefined, 'h')).toBeNull();
    expect(state.rows).toEqual([]);
  });

  it('a chat that is no place asks nothing (installing for one chat never widens to every agent here)', async () => {
    const here = computer();
    await installHere(here);
    await given.setAppPlaces('searcher', ['g']);
    expect(await installHere(here, undefined, 'not-a-place')).toBeNull();
    expect(state.rows.map((row) => row.chatId)).toEqual(['g']);
  });
});

// #6981 × #6976: the line that turns that ask into a sheet is `if (plan.asks || asked)` in extension-agent-actions — a
// reinstall asking for nothing new still goes to the person when it is for a chat the App is not given at. Lose `|| asked`
// and the ask is computed, then dropped: installed quietly, the new chat never offered.
describe('app_install of the same folder App for a chat it is not given at shows the sheet', () => {
  beforeEach(() => {
    state.rows = [];
  });

  it('asks for chat h (nothing new in the bundle), stays quiet for chat g where it is given already', async () => {
    const here = computer();
    await installHere(here);
    await given.setAppPlaces('searcher', ['g']);
    const { runExtensionAgentAction } = await import('./extension-agent-actions');
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    const dependencies = { requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() };

    await expect(runExtensionAgentAction({ action: 'install', source_dir: source(), chat_id: 'h' }, dependencies))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(requestInstallConsent.mock.calls[0]![0].places.find((place: { id: string }) => place.id === 'h')?.enabled).toBe(true);

    await expect(runExtensionAgentAction({ action: 'install', source_dir: source(), chat_id: 'g' }, dependencies))
      .resolves.toMatchObject({ installed: true });
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
  });
});

// 主人 10-16「去掉插件授权范围里面的"给任何非项目 agent"这个选项」: a computer still keeping that place (`here:projectless`)
// from before gives nobody anything by it — never widened to every agent here — and the next answer leaves it out.
describe('a computer that kept only the removed 「agents in no project」', () => {
  beforeEach(() => {
    state.rows = [];
  });

  it('shows the App given to nobody, and installing it again for a chat keeps only what is a place', async () => {
    const root = path.join(work, `installed-${Math.random().toString(36).slice(2)}`);
    const here = new ExtensionsService(root);
    await installHere(here);
    const app = { publisher: 'owner-1', id: 'searcher' };
    writeFileSync(path.join(root, '.given-here.json'), JSON.stringify({ 'owner-1/searcher': ['here:projectless'] }));
    expect(here.givenHere(app)).toEqual(['here:projectless']);

    expect((await given.appPlaces('searcher')).filter((place) => place.enabled)).toEqual([]);

    // The sheet answers with the places it lists, as they are switched: the kept one is none of them.
    const asked = await installHere(here, (ask) => ask.places.filter((place) => place.enabled).map((place) => place.id), 'h');
    expect(asked?.places.filter((place) => place.enabled).map((place) => place.id)).toEqual(['h']);
    expect(here.givenHere(app)).toEqual([]);
    expect(state.rows.map((row) => row.chatId)).toEqual(['h']);
  });

  // 复核·二代 10-16: an install that records what it ticked at first (no answer with places: 「没弹框 = 照原样」) — the kept
  // one is not among the ticks, so it is never written as a chat and the chat this install is for is given.
  it('installing it again for a chat with no answer of places gives that chat, and keeps nothing removed', async () => {
    const root = path.join(work, `installed-${Math.random().toString(36).slice(2)}`);
    const here = new ExtensionsService(root);
    await installHere(here);
    writeFileSync(path.join(root, '.given-here.json'), JSON.stringify({ 'owner-1/searcher': ['here:projectless'] }));

    const asked = await installHere(here, undefined, 'h');
    expect(asked?.ticks).toEqual(['h']);
    expect(state.rows.map((row) => row.chatId)).toEqual(['h']);
    expect(here.givenHere({ publisher: 'owner-1', id: 'searcher' })).toEqual([]);
  });
});

// owner 10-17 (体检 #21): which agents get an App unread fails its install, said — never «not asked», which gave every agent here.
describe('places unread at an install', () => {
  beforeEach(() => {
    state.rows = [];
    state.unread = new Error('network down');
  });
  afterEach(() => {
    state.unread = null;
  });

  // The one install path every source goes through (installPrepared): it rejects with the reason, nothing lands, nobody is
  // asked, nothing is applied. Positive control below: the same call with the places readable installs.
  async function prepare(here: ExtensionsService) {
    state.service = here;
    const dir = source();
    const { manifest, manifestDigest } = here.inspectDirectory(dir);
    return {
      dir,
      manifest,
      manifestDigest,
      origin: 'folder' as const,
      publisher: { id: 'owner-1' },
      asks: true,
      sheet: { revokedPermissions: [] },
      places: { first: true, identity: await given.ownInstallIdentity('searcher', 'folder') },
    };
  }

  it('the install is refused with the reason, nothing installed', async () => {
    const here = computer();
    const requestInstallConsent = vi.fn(async () => ({ outcome: 'confirmed' as const }));
    const afterInstall = vi.fn();
    await expect(installPrepared(await prepare(here), { kind: 'here' }, { requestInstallConsent, afterInstall }))
      .rejects.toThrow('network down');
    expect(here.list().extensions).toEqual([]);
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(afterInstall).not.toHaveBeenCalled();
  });

  it('control: the places read, the same call installs', async () => {
    state.unread = null;
    const here = computer();
    const requestInstallConsent = vi.fn(async () => ({ outcome: 'confirmed' as const }));
    const done = await installPrepared(await prepare(here), { kind: 'here' }, { requestInstallConsent, afterInstall: vi.fn() });
    expect(done.outcome).toBe('confirmed');
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(here.list().extensions.map((one) => one.manifest.id)).toEqual(['searcher']);
  });
});
