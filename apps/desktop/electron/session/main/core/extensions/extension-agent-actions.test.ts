import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { consentPrompt } from '@renderer/features/extensions/extension-consent';
import type { ExtensionInstallConsentRequest } from '@shared/extensions/host-actions';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * app_* 原子工具背后的分派层 —— 此前一条判据都没有。
 *
 * 这一层做的事看着只是转发,其实有两处会静默出错:一是 agent 那侧的字段是 snake_case
 * (`opens_files`),脚手架那侧是 camelCase(`opensFiles`),改名漏一个就是「声明了却没
 * 写进 manifest」—— 装上去认领不生效,而没有任何地方报错;二是工具描述里写的动作与这里
 * 真正接住的动作可能对不上,agent 调一个不存在的动作只会拿到一句解析错误。
 *
 * 这里用真的 scaffoldExtension(临时目录),只把 extensionsService 挡掉。Refs #2374
 */

const inspectDirectory = vi.fn();
const installFromDirectory = vi.fn();
const list = vi.fn();
const revokedPermissions = vi.fn();
const origins = vi.fn();
const isEnabled = vi.fn();
const setAutoUpdate = vi.fn();
const olderInterface = vi.fn();
const disclosure = vi.fn((_id: string) => 'progressive');

// A folder install is published by the account installing it (app-identity.ts).
const INSTALLING_ACCOUNT = vi.hoisted(() => ({ id: '0a000000-0000-4000-8000-00000000000a' }));
vi.mock('./app-files', () => ({
  folderPublisher: async () => INSTALLING_ACCOUNT,
  readAccount: async () => ({ type: 'human', owner_user_id: null, display_name: 'profile name' }),
}));
vi.mock('@main/core/extensions/extensions-root', () => ({
  appSourcesRoot: () => path.join(workDir, 'app-sources'),
  extensionsService: () => ({
    approvedManifest: (id: string) => list().extensions.find((entry: {manifest: {id: string}}) => entry.manifest.id === id).manifest,
    isInstalled: (id: string) => list().extensions.some((entry: { manifest: { id: string } }) => entry.manifest.id === id),
    get: (id: string) => list().extensions.find((entry: { manifest: { id: string } }) => entry.manifest.id === id),
    // One publisher throughout these cases: a first install is one not installed yet.
    olderInterface,
    isFirstInstallOf: (id: string) => !list().extensions.some((entry: { manifest: { id: string } }) => entry.manifest.id === id),
    variants: () => ({ active: 'upstream', variants: [] }),
    inspectDirectory,
    installFromDirectory,
    list,
    revokedPermissions,
    origins,
    isEnabled,
    setAutoUpdate,
    // How its tools reach agents once installed: the install answer says it (D-28).
    disclosure,
    // Where this computer gave an App before: none recorded (every agent here), so reinstalling asks nothing.
    givenHere: () => null,
  }),
}));

// 「给哪些 agent」要读账号的行;这些用例没有登录态,不问(D-30 自己的读写在 app-given 的用例里判)。
// 读不到时安装会失败(owner 10-17 体检 #21),所以这里把「问」定成没有可问的,而不是靠吞错。
vi.mock('./app-given', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-given')>()),
  installGrant: async () => null,
  recordInstallGrant: async () => undefined,
}));

const { runExtensionAgentAction } = await import('./extension-agent-actions');
const { setSessionHostLocale } = await import('@main/core/host-locale');
// app_create writes the person's interface language as a new App's defaultLocale.
setSessionHostLocale('zh-CN');
const { CloudExtensionMarket } = await import('./market-catalog');
const { claimedSuffixes, opensFilesSchema } = await import('@shared/extensions/manifest');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'gugu-ext-actions-'));
  inspectDirectory.mockReset();
  installFromDirectory.mockReset();
  list.mockReset();
  revokedPermissions.mockReset();
  origins.mockReset();
  isEnabled.mockReset();
  olderInterface.mockReset();
  olderInterface.mockReturnValue(null);
  disclosure.mockReset();
  disclosure.mockReturnValue('progressive');
  // Nothing installed unless a test says so: `create` reads the inventory too, to say what `install` will do.
  list.mockReturnValue({ extensions: [], invalid: [] });
  revokedPermissions.mockReturnValue([]);
  origins.mockReturnValue({});
  isEnabled.mockReturnValue(true);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type TabCommand = { id: string; title: string };
type ScaffoldedManifest = {
  permissions?: { capabilities?: string[]; network?: string[] };
  contributes: {
    tabs: {
      name: string;
      entry?: string;
      opensFiles?: { session?: string[]; chat?: string[] };
      menu?: TabCommand[];
      toolbar?: TabCommand[];
    }[];
  };
};

function manifestAt(sourceDir: string): ScaffoldedManifest {
  return JSON.parse(readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
}

/** One tab of the agent's own (S1): declared in manifest.contributes.tabs, its page in files as <name>.html. */
const ownTab = (tab: Record<string, unknown> = {}) => ({
  manifest: { contributes: { tabs: [{ name: 'main', title: 'Main', ...tab }] } },
  files: { 'main.html': '<!doctype html>' },
});

describe('app_* 的动作分派', () => {
  it('认领、菜单、工具栏一路走到 manifest —— 改名漏一个就等于没声明', async () => {
    const created = (await runExtensionAgentAction({
      action: 'create',
      target_dir: path.join(workDir, 'sql'),
      id: 'sql-lens',
      name: 'SQL Lens',
      opens_files: { session: ['.sql'] },
      ...ownTab({ title: 'SQL', menu: [{ id: 'reload', title: 'Reload' }], toolbar: [{ id: 'format', title: 'Format' }] }),
    })) as { source_dir: string; next: string };

    const tab = manifestAt(created.source_dir).contributes.tabs[0];
    expect(tab?.opensFiles, 'opens_files 没有变成 opensFiles').toEqual({ session: ['.sql'] });
    expect(tab?.menu).toEqual([{ id: 'reload', title: 'Reload' }]);
    expect(tab?.toolbar).toEqual([{ id: 'format', title: 'Format' }]);
    expect(tab?.entry).toBe('main.html');
    expect(readFileSync(path.join(created.source_dir, 'main.html'), 'utf8')).toBe('<!doctype html>');
    // 这些都不是权限,所以 agent 自己就能装。与下一条用**同一个正则、相反期望**,
    // 互为对照 —— 只判 /install/ 的话,「你装不上」那句里也有 install,两边都会绿。
    expect(created.next).toMatch(/app_install/);
  });

  // 摩擦单 F1(L5):群里的文件要写 { chat: [...] },工具以前只收纯数组 —— agent 只好先 Read 再 Edit 手改 manifest。
  it('opens_files 收 manifest 的整套写法:{ chat } 原样写进 manifest,群里认、任务里不认', async () => {
    const created = (await runExtensionAgentAction({
      action: 'create',
      target_dir: path.join(workDir, 'poll'),
      id: 'poll',
      name: 'Poll',
      opens_files: { chat: ['.poll', '.JSON'] },
      ...ownTab(),
    })) as { source_dir: string };

    const tab = manifestAt(created.source_dir).contributes.tabs[0]!;
    // The manifest's own schema normalises the suffix, as for a hand-written manifest.
    expect(tab.opensFiles).toEqual({ chat: ['.poll', '.json'] });
    expect(claimedSuffixes(tab, 'chat')).toEqual(['.poll', '.json']);
    expect(claimedSuffixes(tab, 'session'), '对照:没说会话的就不认领会话的').toEqual([]);

    // Both contexts at once; a second tab claims in its manifest entry.
    const both = (await runExtensionAgentAction({
      action: 'create',
      target_dir: path.join(workDir, 'both'),
      id: 'both',
      name: 'Both',
      opens_files: { session: ['.csv'], chat: ['.csv'] },
      manifest: { contributes: { tabs: [{ name: 'a', title: 'A' }, { name: 'b', title: 'B', opensFiles: { session: ['.tsv'] } }] } },
      files: { 'a.html': '<html></html>', 'b.html': '<html></html>' },
    })) as { source_dir: string };
    const [a, b] = manifestAt(both.source_dir).contributes.tabs;
    expect(a?.opensFiles).toEqual({ session: ['.csv'], chat: ['.csv'] });
    expect(claimedSuffixes(b!, 'session')).toEqual(['.tsv']);
    expect(claimedSuffixes(b!, 'chat')).toEqual([]);
    expect([a?.entry, b?.entry], 'each tab its own page').toEqual(['a.html', 'b.html']);
  });

  // 原 extensionCreateOpensFiles(MCP 侧):工具把 opens_files 原样交下来,收什么、拒什么由 manifest 的 schema 定。
  it.each([
    ['an empty object', {}],
    ['an empty group list', { chat: [] }],
    ['a suffix without its dot', { chat: ['md'] }],
    ['an unknown context (group is chat now)', { chat: ['.md'], group: ['.md'] }],
  ])('opens_files: %s is refused as the manifest refuses it, and nothing is written', async (_, opensFiles) => {
    expect(opensFilesSchema.safeParse(opensFiles).success).toBe(false);
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'bad'), id: 'bad', name: 'Bad', template: 'group-json', opens_files: opensFiles,
    })).rejects.toThrow();
    expect(existsSync(path.join(workDir, 'bad', 'manifest.json')), '拒了就什么都没写').toBe(false);
  });

  it('opens_files said twice, differently — the parameter and the first tab — is refused; said the same, it is one claim', async () => {
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'twice'), id: 'twice', name: 'Twice',
      opens_files: { chat: ['.md'] }, ...ownTab({ opensFiles: { session: ['.txt'] } }),
    })).rejects.toThrow(/opens_files says \{"chat":\[".md"\]\} and manifest\.contributes\.tabs\[0\]\.opensFiles says \{"session":\[".txt"\]\}/);
    const same = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'same'), id: 'same', name: 'Same',
      opens_files: { chat: ['.md'] }, ...ownTab({ opensFiles: { chat: ['.md'] } }),
    })) as { source_dir: string };
    expect(manifestAt(same.source_dir).contributes.tabs[0]?.opensFiles).toEqual({ chat: ['.md'] });
  });

  it('要了权限的,当场告诉 agent 装不上 —— 别让它下一步才撞墙', async () => {
    const created = (await runExtensionAgentAction({
      action: 'create',
      target_dir: path.join(workDir, 'reader'),
      id: 'reader',
      name: 'Reader',
      ...ownTab(),
      manifest: {
        permissions: { capabilities: ['files:read'], network: ['api.example.com'] },
        contributes: { tabs: [{ name: 'main', title: 'Read' }] },
      },
    })) as { source_dir: string; next: string };

    expect(manifestAt(created.source_dir).permissions).toEqual({
      capabilities: ['files:read'],
      network: ['api.example.com'],
    });
    // 说清是哪几样,agent 才知道要么去掉、要么去找人。
    expect(created.next).toContain('files:read');
    expect(created.next).toContain('api.example.com');
    expect(created.next).not.toMatch(/app_install/);
  });

  // 摩擦单 F107: the host asks for it when the group already holds this version's card with other bytes.
  it('bump: the patch number goes up by one in the bundle\'s manifest.json, the rest of it as it was', async () => {
    const manifest = { id: 'dinner-vote', name: 'Dinner vote', version: '1.2.9', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', contributes: { tabs: [] } };
    writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest));
    expect(await runExtensionAgentAction({ action: 'bump', source_dir: workDir })).toEqual({ version: '1.2.10' });
    expect(JSON.parse(readFileSync(path.join(workDir, 'manifest.json'), 'utf8'))).toEqual({ ...manifest, version: '1.2.10' });
  });

  it('不认识的动作报错,❌ 不静静地当成别的动作', async () => {
    await expect(runExtensionAgentAction({ action: 'locate', tab: 'main' })).rejects.toThrow();
  });

  it('权限扩展先把同一份 manifest/digest 交给人工确认,确认后才安装', async () => {
    const manifest = {
      id: 'reader',
      name: 'Reader',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'main.html',
      permissions: { capabilities: ['files:read'] },
      contributes: { tabs: [{ name: 'main', title: 'Read', entry: 'main.html' }] },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-a' });
    list.mockReturnValue({ extensions: [], invalid: [] });
    revokedPermissions.mockReturnValue([]);
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/reader' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    const notifyInstalledChanged = vi.fn().mockResolvedValue(undefined);
    const afterInstall = vi.fn();

    const result = await runExtensionAgentAction(
      { action: 'install', source_dir: '/tmp/reader-source' },
      { requestInstallConsent, notifyInstalledChanged, afterInstall }
    ) as { installed: boolean; outcome: string };

    expect(requestInstallConsent).toHaveBeenCalledWith(expect.objectContaining({
      sourceDir: '/tmp/reader-source',
      manifest,
      manifestDigest: 'digest-a',
      revokedPermissions: [],
    }));
    expect(installFromDirectory).toHaveBeenCalledWith('/tmp/reader-source', 'digest-a', 'folder', INSTALLING_ACCOUNT, undefined);
    // 装完必须喊这一声,否则新 tab 要整页刷新才出现(owner 实测 #4135)。
    expect(notifyInstalledChanged).toHaveBeenCalled();
    // #6387 与设置页那条安装路径同一套善后:后台页要拉起来,否则它的工具一个也接不住。
    expect(afterInstall).toHaveBeenCalledWith({ manifest, rootDir: '/tmp/reader' });
    expect(result).toEqual(expect.objectContaining({ installed: true, outcome: 'confirmed' }));
  });

  it('carries the older interface version through the real consent prompt before installing', async () => {
    const manifest = parseExtensionManifest({
      id: 'reader', name: 'Reader', version: '2.1.24', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      entry: 'main.html', permissions: { capabilities: ['files:read', 'files:write'] },
      contributes: { tabs: [{ name: 'main', title: 'Read' }] },
    });
    olderInterface.mockReturnValue({ id: 'reader', version: '1.0.4', permissions: { capabilities: ['files:read'] } });
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-new-interface' });
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/reader' });
    const requestInstallConsent = vi.fn(async (request: ExtensionInstallConsentRequest) => {
      expect(installFromDirectory).not.toHaveBeenCalled();
      const prompt = consentPrompt(request.installed, request.revokedPermissions, manifest, key => key, 'en-US');
      expect(request.installed).toEqual({ version: '1.0.4', permissions: { capabilities: ['files:read'] } });
      expect(prompt.title).toBe('extensions.updateConfirmTitle');
      expect(prompt.description).toBe('extensions.updateNewPermissions');
      return { outcome: 'confirmed' as const };
    });

    await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/reader-source' }, {
      requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn(),
    })).resolves.toMatchObject({ installed: true, outcome: 'confirmed', version: '2.1.24' });
    expect(olderInterface).toHaveBeenCalledWith('reader');
    expect(requestInstallConsent).toHaveBeenCalledOnce();
    expect(installFromDirectory).toHaveBeenCalledWith('/tmp/reader-source', 'digest-new-interface', 'folder', INSTALLING_ACCOUNT, undefined);
  });

  it.each(['declined', 'dismissed', 'timeout'] as const)(
    '人工 %s 时不安装且把结果交还 agent',
    async (outcome) => {
      const manifest = {
        id: 'reader',
        name: 'Reader',
        version: '1.0.0',
        apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
        platforms: ['desktop'],
        entry: 'main.html',
        permissions: { network: ['api.example.com'] },
        contributes: { tabs: [{ name: 'main', title: 'Read', entry: 'main.html' }] },
      };
      inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-b' });
      list.mockReturnValue({ extensions: [], invalid: [] });
      revokedPermissions.mockReturnValue([]);
      const requestInstallConsent = vi.fn().mockResolvedValue({ outcome });
      const notifyInstalledChanged = vi.fn().mockResolvedValue(undefined);

      const result = await runExtensionAgentAction(
        { action: 'install', source_dir: '/tmp/reader-source' },
        { requestInstallConsent, notifyInstalledChanged }
      ) as { installed: boolean; outcome: string };

      expect(installFromDirectory).not.toHaveBeenCalled();
      // 没装成就别喊 —— 喊了等于让界面为一次没发生的安装做一轮重登记。
      expect(notifyInstalledChanged).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ installed: false, outcome }));
    }
  );
});

it('#6646 E-05: a folder install that would replace one from the market, a chat or from before origins were kept asks the person; one from a folder does not', async () => {
  const manifest = {
    id: 'notes', name: 'Notes', version: '2.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  };
  inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-n' });
  list.mockReturnValue({ extensions: [{ manifest: { ...manifest, version: '1.0.0' } }], invalid: [] });
  revokedPermissions.mockReturnValue([]);
  installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/notes' });
  const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
  const dependencies = { requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() };
  for (const origin of ['market', 'attachment', undefined]) {
    origins.mockReturnValue(origin ? { notes: origin } : {});
    await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/notes-source' }, dependencies))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
  }
  expect(requestInstallConsent).toHaveBeenCalledTimes(3);
  expect(installFromDirectory).not.toHaveBeenCalled();
  origins.mockReturnValue({ notes: 'folder' });
  await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/notes-source' }, dependencies))
    .resolves.toMatchObject({ installed: true });
  expect(requestInstallConsent).toHaveBeenCalledTimes(3);
  expect(installFromDirectory).toHaveBeenCalledWith('/tmp/notes-source', 'digest-n', 'folder', INSTALLING_ACCOUNT, undefined);
});

describe('reinstalling its own folder extension (quiet upgrade)', () => {
  const v1 = {
    id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: ['files:read'] },
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  };

  beforeEach(() => {
    list.mockReturnValue({ extensions: [{ manifest: v1 }], invalid: [] });
    origins.mockReturnValue({ notes: 'folder' });
    revokedPermissions.mockReturnValue(['files:read']);
  });

  it('replaces without asking when the version asks for nothing new, and asks when it does', async () => {
    const v2 = { ...v1, version: '2.0.0' };
    inspectDirectory.mockReturnValue({ manifest: v2, manifestDigest: 'digest-2' });
    installFromDirectory.mockReturnValue({ manifest: v2, rootDir: '/tmp/notes' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    const dependencies = { requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() };

    await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/notes-v2' }, dependencies))
      .resolves.toMatchObject({ installed: true, version: '2.0.0' });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(installFromDirectory).toHaveBeenCalledWith('/tmp/notes-v2', 'digest-2', 'folder', INSTALLING_ACCOUNT, undefined);
    // The same aftercare as an asked install: running sessions get the new version on their next call.
    expect(dependencies.afterInstall).toHaveBeenCalledWith({ manifest: v2, rootDir: '/tmp/notes' });
    expect(dependencies.notifyInstalledChanged).toHaveBeenCalled();

    const v3 = { ...v1, version: '3.0.0', permissions: { capabilities: ['files:read'], network: ['api.example.com'] } };
    inspectDirectory.mockReturnValue({ manifest: v3, manifestDigest: 'digest-3' });
    await runExtensionAgentAction({ action: 'install', source_dir: '/tmp/notes-v3' }, dependencies);
    expect(requestInstallConsent).toHaveBeenCalledWith(expect.objectContaining({
      manifest: v3,
      installed: v1,
      revokedPermissions: ['files:read'],
    }));
  });

  // 摩擦单 F52(L5 S2):界面卡住时 install 报「IPC timeout: extensions:cmd/extensions.installedChanged」,App 其实已经装上。
  // 副作用已经发生的,回包绝不能是 error:装上就是 installed,界面没点头只在 next 里多一句。
  it('installed is installed: a window that refuses or never answers adds a sentence, never an error', async () => {
    const v2 = { ...v1, version: '2.0.0' };
    inspectDirectory.mockReturnValue({ manifest: v2, manifestDigest: 'digest-2' });
    installFromDirectory.mockReturnValue({ manifest: v2, rootDir: '/tmp/notes' });
    const run = (notifyInstalledChanged: () => Promise<void>) =>
      runExtensionAgentAction({ action: 'install', source_dir: '/tmp/notes-v2' }, { notifyInstalledChanged, afterInstall: vi.fn() }) as Promise<{
        installed: boolean; next?: string;
      }>;
    const note = 'It is installed; the gugu window has not confirmed it yet (it may be busy), so the App shows there in a moment or after a reload.';

    const refused = await run(() => Promise.reject(new Error('IPC timeout: extensions:cmd/extensions.installedChanged')));
    expect(refused.installed).toBe(true);
    expect(refused.next?.startsWith(note)).toBe(true);

    vi.useFakeTimers();
    try {
      const silent = run(() => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(1500);
      const answer = await silent;
      expect(answer.installed).toBe(true);
      expect(answer.next?.startsWith(note)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // Control: a window that confirms adds nothing.
    const shown = await run(() => Promise.resolve());
    expect(shown.next ?? '').not.toContain('has not confirmed');
  });

  it('create says ahead of time which of the two the next install will be', async () => {
    const notes = (permissions: Record<string, string[]>) => ({
      ...ownTab(),
      manifest: { permissions, contributes: { tabs: [{ name: 'main', title: 'Notes' }] } },
    });
    const same = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'same'), id: 'notes', name: 'Notes',
      ...notes({ capabilities: ['files:read'] }),
    })) as { next: string };
    expect(same.next).toMatch(/Call app_install with this source_dir to make its tabs appear/);
    expect(same.next).not.toMatch(/ask the person/);

    const wider = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'wider'), id: 'notes', name: 'Notes',
      ...notes({ capabilities: ['files:read'], network: ['api.example.com'] }),
    })) as { next: string };
    expect(wider.next).toMatch(/The next install call will ask the person to review and decide on api\.example\.com\./);
  });
});

/**
 * #6615 问题 11 —— W-21 实测:两家 agent 写带程序的扩展时,都得先去掉 agents:tools 才建得出来,再手改
 * manifest.json 把 mcpServers 补回去(app_create 没有那几个字段,manifest 又要求二者同在)。
 */
describe('app_create 写得出给 agent 的程序、skills 与后台页 (#6615 问题 11)', () => {
  it('creates a tools-only App without a template, tabs or HTML, and keeps it editable by a second create', async () => {
    const target = path.join(workDir, 'tool-only');
    const request = { action: 'create', id: 'tool-only', name: 'Tool only', target_dir: target,
      manifest: { permissions: { capabilities: ['agents:tools'] }, contributes: { mcpServers: [{ tools: 'tools.js' }], instructions: 'tool-only tools.' } },
      files: { 'tools.js': 'export const ping = { run: async () => "pong" };' } };
    await runExtensionAgentAction(request);
    const first = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    expect(first.entry).toBeUndefined();
    expect(first.contributes.tabs).toEqual([{ name: 'settings', title: 'Settings', hostPage: 'settings' }]);
    await runExtensionAgentAction({ ...request, files: { 'tools.js': 'export const ping = { run: async () => "updated" };' } });
    const updated = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    expect(updated.entry).toBeUndefined();
    expect(updated.contributes.tabs).toEqual(first.contributes.tabs);
  });
  // S1 The same things, now as manifest.json writes them: the fragment, and each page it names in files.
  const withTools = {
    action: 'create',
    id: 'readme-count',
    name: 'README Count',
    manifest: {
      background: { entry: 'background.html' },
      permissions: { capabilities: ['files:read', 'agents:tools'] },
      contributes: {
        tabs: [{ name: 'main', title: 'README' }],
        mcpServers: [{ name: 'readme-count', command: 'node', args: ['mcp/server.mjs'], env: { MODE: 'words' } }],
        skills: 'skills',
        instructions: 'readme-count__count(path): words in a README; skill readme-count first.',
      },
    },
    files: {
      'main.html': '<!doctype html><script src="main.js"></script>',
      'background.html': '<!doctype html><title>bg</title>',
    },
  };

  it('一次 create 就是能装的 manifest:mcpServers / skills / background 与手写 bundle 同形', async () => {
    const created = (await runExtensionAgentAction({ ...withTools, target_dir: path.join(workDir, 'rc') })) as {
      source_dir: string;
      next: string;
    };
    const manifest = JSON.parse(readFileSync(path.join(created.source_dir, 'manifest.json'), 'utf8'));
    expect(manifest.contributes.mcpServers).toEqual([
      { name: 'readme-count', command: 'node', args: ['mcp/server.mjs'], env: { MODE: 'words' } },
    ]);
    expect(manifest.contributes.skills).toBe('skills');
    expect(manifest.background).toEqual({ entry: 'background.html' });
    expect(readFileSync(path.join(created.source_dir, 'background.html'), 'utf8')).toBe('<!doctype html><title>bg</title>');
    // 读回来就是安装那一侧会读的那份:同一个 schema,不是「看着像」。
    const { extensionManifestSchema } = await import('@shared/extensions/manifest');
    expect(() => extensionManifestSchema.parse(manifest)).not.toThrow();
    // 还没写的文件当场点名:程序那一行、skills 目录的形状。仍是要人同意的 bundle,所以不叫它自己去 install。
    expect(created.next).toContain('node mcp/server.mjs');
    expect(created.next).toContain('skills/<skill>/SKILL.md');
    expect(created.next).toContain('agents:tools');
    expect(created.next).not.toMatch(/app_install/);
  });

  it('摩擦单 F77 a tools module: the manifest keeps it as written; only a file not given yet is asked for', async () => {
    const tools = {
      ...withTools,
      manifest: { ...withTools.manifest, contributes: { ...withTools.manifest.contributes, mcpServers: [{ tools: 'tools.js' }] } },
    };
    const given = (await runExtensionAgentAction({
      ...tools,
      files: { ...withTools.files, 'tools.js': 'export const count = {}' },
      target_dir: path.join(workDir, 'rc-tools'),
    })) as { source_dir: string; next: string };
    const manifest = JSON.parse(readFileSync(path.join(given.source_dir, 'manifest.json'), 'utf8'));
    expect(manifest.contributes.mcpServers).toEqual([{ tools: 'tools.js' }]);
    expect(readFileSync(path.join(given.source_dir, 'tools.js'), 'utf8')).toBe('export const count = {}');
    expect(given.next).not.toMatch(/Write the files its programs run/);
    // Control: the same call without tools.js names it.
    const missing = (await runExtensionAgentAction({ ...tools, target_dir: path.join(workDir, 'rc-tools-2') })) as { next: string };
    expect(missing.next).toContain('Write the files its programs run (tools.js)');
  });

  it('阴性对照:给了程序却没声明 agents:tools,照旧当场拒 —— 安装单上不会少写一行', async () => {
    await expect(
      runExtensionAgentAction({
        ...withTools,
        manifest: { ...withTools.manifest, permissions: { capabilities: ['files:read'] } },
        target_dir: path.join(workDir, 'rc2'),
      })
    // ZodError 的 message 是 JSON,引号带反斜杠转义。
    ).rejects.toThrow(/must declare \\?"agents:tools\\?"/);
  });

  it('装完告诉 agent:工具与 skills 此刻都在本会话的 catalog 里 —— ❌ 旧话「本会话没有」(#6387)', async () => {
    const manifest = {
      id: 'readme-count',
      name: 'README Count',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'main.html',
      permissions: { capabilities: ['agents:tools'] },
      contributes: {
        tabs: [{ name: 'main', title: 'README', entry: 'main.html' }],
        mcpServers: [{ name: 'readme-count', command: 'node', args: ['mcp/server.mjs'] }],
        skills: 'skills',
        instructions: 'readme-count__count(path): words in a README; skill readme-count first.',
      },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-rc' });
    list.mockReturnValue({ extensions: [], invalid: [] });
    revokedPermissions.mockReturnValue([]);
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/rc' });
    const result = (await runExtensionAgentAction(
      { action: 'install', source_dir: '/tmp/rc-source' },
      {
        requestInstallConsent: vi.fn().mockResolvedValue({ outcome: 'confirmed' }),
        notifyInstalledChanged: vi.fn().mockResolvedValue(undefined),
        afterInstall: vi.fn(),
      }
    )) as { for_agents: string };
    expect(result.for_agents).toMatch(/in this session too/);
    // #6634 问题 16: nothing asked its programs yet — no promise that the tools are there, and where a missing one is explained.
    expect(result.for_agents).not.toMatch(/are in the catalog now/);
    expect(result.for_agents).toContain('asking for a tool that is not there says which program was left out and why');
    expect(result.for_agents).toContain('catalog_list with name "readme-count"');
    expect(result.for_agents).toContain('catalog_call');
    // #6387 skills ride the catalog with the tools: no「本会话没有」left at all.
    expect(result.for_agents).toContain('Its skills are in the catalog too, next to its tools: catalog_list with name "readme-count" shows each one and the SKILL.md to read.');
    expect(result.for_agents).not.toContain('does not have them');
    expect(result.for_agents).toContain('From the next session on the person can have them listed natively instead.');
  });

  // D-28: an App that asked for its tools to be listed (toolsListed, at its first install) — the answer says what the
  // install left, read from the disclosure, not that the person still has to switch it on.
  it('装完时工具已是完全披露:回包说「下个会话起直接列出」,❌ 说「人可以去改成直接列出」', async () => {
    const manifest = {
      id: 'searcher',
      name: 'Searcher',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'main.html',
      permissions: { capabilities: ['agents:tools'] },
      contributes: { tabs: [{ name: 'main', title: 'Searcher', entry: 'main.html' }], mcpServers: [{ tools: 'tools.js' }], toolsListed: true, instructions: 'Searcher tools.' },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-s' });
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/s' });
    disclosure.mockImplementation((id: string) => (id === 'searcher' ? 'full' : 'progressive'));
    const result = (await runExtensionAgentAction(
      { action: 'install', source_dir: '/tmp/s-source' },
      {
        requestInstallConsent: vi.fn().mockResolvedValue({ outcome: 'confirmed' }),
        notifyInstalledChanged: vi.fn().mockResolvedValue(undefined),
        afterInstall: vi.fn(),
      }
    )) as { for_agents: string };
    expect(result.for_agents).toContain('From the next session on they are listed natively (the person can switch that back).');
    expect(result.for_agents).not.toContain('can have them listed natively instead');
  });

  // D-30 A-B C4c: the person took the installing agent's group out on the sheet — its catalog then says not given.
  it('主人没把它给装它的这个 agent:回包照 catalog 说「没给你」,❌ 说「本会话的 catalog 里就有」', async () => {
    const manifest = {
      id: 'searcher',
      name: 'Searcher',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'main.html',
      permissions: { capabilities: ['agents:tools'] },
      contributes: { tabs: [{ name: 'main', title: 'Searcher', entry: 'main.html' }], mcpServers: [{ tools: 'tools.js' }], instructions: 'Searcher tools.' },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-s' });
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/tmp/s' });
    const callerHasApp = vi.fn().mockResolvedValue(false);
    const result = (await runExtensionAgentAction(
      { action: 'install', source_dir: '/tmp/s-source' },
      {
        requestInstallConsent: vi.fn().mockResolvedValue({ outcome: 'confirmed' }),
        notifyInstalledChanged: vi.fn().mockResolvedValue(undefined),
        afterInstall: vi.fn(),
        callerHasApp,
      }
    )) as { for_agents: string };
    expect(callerHasApp).toHaveBeenCalledWith('searcher');
    expect(result.for_agents).toContain('Its owner did not give it to you');
    expect(result.for_agents).not.toMatch(/in this session too|catalog_list/);
  });
});

// skill 注入核查 10-14 坏签探针: a SKILL.md whose frontmatter is not YAML reached no session, and app_install said nothing.
describe('app_install says which skill no agent gets, in its reader\'s words', () => {
  const stamps = {
    id: 'skillx-bad',
    name: '坏签探针',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'],
    entry: 'main.html',
    permissions: { capabilities: ['agents:tools'] },
    contributes: { tabs: [{ name: 'main', title: '坏签探针', entry: 'main.html' }], skills: 'skills', instructions: 'Read skill bad-stamp first.' },
  };
  const BAD = '---\nname: bad-stamp\ndescription: Use when someone asks for a red stamp (红签): run its script.\n---\n';
  const OK = '---\nname: ok-stamp\ndescription: "Use when someone asks for a green stamp (绿签): run its script."\n---\n';

  function installedWith(skills: Record<string, string>): string {
    const rootDir = path.join(workDir, 'installed', 'skillx-bad');
    for (const [folder, text] of Object.entries(skills)) {
      mkdirSync(path.join(rootDir, 'skills', folder), { recursive: true });
      writeFileSync(path.join(rootDir, 'skills', folder, 'SKILL.md'), text);
    }
    inspectDirectory.mockReturnValue({ manifest: stamps, manifestDigest: 'digest-stamps' });
    installFromDirectory.mockReturnValue({ manifest: stamps, rootDir });
    return rootDir;
  }
  const requestInstallConsent = vi.fn();
  const install = () => runExtensionAgentAction(
    { action: 'install', source_dir: '/tmp/stamps-source' },
    { requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() }
  ) as Promise<{ installed: boolean; next?: string }>;

  beforeEach(() => {
    requestInstallConsent.mockReset();
    requestInstallConsent.mockResolvedValue({ outcome: 'confirmed' });
  });

  it('the broken one by name, its SKILL.md and why — on the first (asked) install and on the quiet reinstall an author fixing it makes', async () => {
    const rootDir = installedWith({ 'bad-stamp': BAD, 'ok-stamp': OK });
    const said = `No agent gets this skill: extension skillx-bad: skill bad-stamp left out of the session (${path.join(rootDir, 'skills', 'bad-stamp', 'SKILL.md')}): Nested mappings are not allowed`;

    const first = await install();
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(first.installed).toBe(true);
    expect(first.next).toContain(said);
    expect(first.next).not.toContain('ok-stamp');

    // Its own folder install again, asking nothing new: no consent, so no for_agents — said all the same.
    list.mockReturnValue({ extensions: [{ manifest: stamps }], invalid: [] });
    origins.mockReturnValue({ 'skillx-bad': 'folder' });
    revokedPermissions.mockReturnValue(['agents:tools']);
    const again = await install();
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(again.installed).toBe(true);
    expect(again.next).toContain(said);
  });

  it('control: every skill read — nothing said about skills', async () => {
    installedWith({ 'ok-stamp': OK });
    const answer = await install();
    expect(answer.installed).toBe(true);
    expect(answer.next ?? '').not.toContain('No agent gets this skill');
  });

  // 评审 824a8a6abc ①: skills naming a file threw ENOTDIR here, after the App was installed — the answer was an error.
  it('skills naming a file: installed all the same, and said', async () => {
    const rootDir = installedWith({});
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(path.join(rootDir, 'SKILL.md'), OK);
    const flat = { ...stamps, contributes: { ...stamps.contributes, skills: 'SKILL.md' } };
    inspectDirectory.mockReturnValue({ manifest: flat, manifestDigest: 'digest-flat' });
    installFromDirectory.mockReturnValue({ manifest: flat, rootDir });
    const answer = await install();
    expect(answer.installed).toBe(true);
    expect(answer.next).toContain(`No agent gets this skill: extension skillx-bad: skills folder cannot be read (${path.join(rootDir, 'SKILL.md')}): ENOTDIR`);
  });
});

// 161 10-15(缺口 2,改法 A):server 照样装 App —— 问人照旧是这个 agent 会话里的审批,装完当场说清 tab 在这里打不开、
// 工具和技能给这台上的 agent。对照(这条之前):server 上 app_install 当场拒。
describe('#6264 咕咕 server(没有窗口)', () => {
  it('install 照装:问过人、装上,回答先说这台没有窗口,❌ 叫它 app_check', async () => {
    const { HEADLESS_INSTALLED_NOTE } = await import('./extension-agent-actions');
    const manifest = {
      id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
      permissions: { capabilities: ['files:read'] },
      contributes: { tabs: [{ name: 'main', title: 'Notes', opensFiles: { chat: ['.notes.json'] } }] },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-n' });
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/installed/notes' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    const answer = (await runExtensionAgentAction(
      { action: 'install', source_dir: path.join(workDir, 'bundle') },
      { headless: true, requestInstallConsent, notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn(), checkSurface: vi.fn() as never }
    )) as { installed: boolean; next: string };
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    expect(installFromDirectory).toHaveBeenCalledTimes(1);
    expect(answer.installed).toBe(true);
    expect(answer.next.startsWith(HEADLESS_INSTALLED_NOTE)).toBe(true);
    expect(answer.next).not.toMatch(/app_check \{/);
  });

  it('人没点头:没装,也就没有那句', async () => {
    const { HEADLESS_INSTALLED_NOTE } = await import('./extension-agent-actions');
    const manifest = {
      id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
      permissions: { capabilities: ['files:read'] }, contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-n' });
    const answer = await runExtensionAgentAction(
      { action: 'install', source_dir: path.join(workDir, 'bundle') },
      { headless: true, requestInstallConsent: vi.fn().mockResolvedValue({ outcome: 'declined' }), notifyInstalledChanged: vi.fn() }
    );
    expect(answer).toEqual({ installed: false, outcome: 'declined', id: 'notes', name: 'Notes' });
    expect(JSON.stringify(answer)).not.toContain(HEADLESS_INSTALLED_NOTE);
    expect(installFromDirectory).not.toHaveBeenCalled();
  });

  it('create 照写,下一步提示照常叫它去 install', async () => {
    const created = (await runExtensionAgentAction(
      {
        action: 'create',
        target_dir: path.join(workDir, 'headless'),
        id: 'headless-ext',
        name: 'Headless',
        ...ownTab(),
      },
      { headless: true }
    )) as { next: string; source_dir: string };
    expect(created.source_dir).toBe(path.join(workDir, 'headless'));
    expect(created.next).not.toMatch(/not available here/);
  });
});

/**
 * #6634 问题 14 —— W-21 实测:Codex 三格都把 target_dir 写成相对路径(`readme-count`、`.gugu-extensions/readme-count`),
 * 被按咕咕自己的 cwd(主目录)解析,bundle 落进 `$HOME`:撞「already contains」、在沙箱外写(5 次审批)、或在项目里整份手写。
 */
describe('agent 给的相对文件夹按它自己的工作副本解析 (#6634 问题 14)', () => {
  const minimal = { action: 'create', id: 'todo-panel', name: 'Todo', ...ownTab({ title: 'Todo' }) };
  // 一个此前从没出现过的名字:旧实现按 cwd 解析,会在 cwd 下建出它 —— 两条用例都拿它当阴性判据。
  const unique = () => `i14-probe-${process.pid}-${Math.random().toString(36).slice(2)}`;

  it('create:相对 target_dir 写进工作副本,❌ 写进咕咕的 cwd', async () => {
    const name = unique();
    const workspaceRoot = vi.fn().mockResolvedValue(workDir);
    const created = (await runExtensionAgentAction({ ...minimal, target_dir: name }, { callerWorkspaceRoot: workspaceRoot })) as {
      source_dir: string;
    };
    expect(created.source_dir).toBe(path.join(workDir, name));
    expect(existsSync(path.join(workDir, name, 'manifest.json'))).toBe(true);
    expect(existsSync(path.resolve(name))).toBe(false);
    expect(workspaceRoot).toHaveBeenCalledTimes(1);
  });

  it('create:没有工作副本又给了相对路径,当场拒并说清楚,哪儿都不写', async () => {
    const name = unique();
    for (const dependencies of [{ callerWorkspaceRoot: vi.fn().mockResolvedValue(null) }, {}]) {
      await expect(runExtensionAgentAction({ ...minimal, target_dir: name }, dependencies)).rejects.toThrow(
        `target_dir "${name}" is relative, and this session has no working copy to take it from; pass an absolute folder`
      );
    }
    expect(existsSync(path.resolve(name))).toBe(false);
  });

  it('create:绝对路径照用,也不去查工作副本', async () => {
    const workspaceRoot = vi.fn().mockResolvedValue('/elsewhere');
    const created = (await runExtensionAgentAction(
      { ...minimal, target_dir: path.join(workDir, 'abs') },
      { callerWorkspaceRoot: workspaceRoot }
    )) as { source_dir: string };
    expect(created.source_dir).toBe(path.join(workDir, 'abs'));
    expect(workspaceRoot).not.toHaveBeenCalled();
  });

  it('install:相对 source_dir 同样按工作副本', async () => {
    const manifest = {
      id: 'todo-panel', name: 'Todo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'main.html',
      contributes: { tabs: [{ name: 'main', title: 'Todo', entry: 'main.html' }] },
    };
    inspectDirectory.mockReturnValue({ manifest, manifestDigest: 'digest-t' });
    installFromDirectory.mockReturnValue({ manifest, rootDir: '/installed/todo-panel' });
    const dependencies = {
      callerWorkspaceRoot: vi.fn().mockResolvedValue(workDir),
      notifyInstalledChanged: vi.fn().mockResolvedValue(undefined),
      afterInstall: vi.fn(),
    };
    await runExtensionAgentAction({ action: 'install', source_dir: 'todo-panel' }, dependencies);
    const resolved = [path.join(workDir, 'todo-panel')];
    expect([...new Set(inspectDirectory.mock.calls.map(([dir]) => dir))]).toEqual(resolved);
    expect(installFromDirectory.mock.calls.map(([dir]) => dir)).toEqual(resolved);
  });

  it('pack:相对 source_dir 同样按工作副本,没有工作副本就拒', async () => {
    inspectDirectory.mockImplementation(() => {
      throw new Error('inspected');
    });
    await expect(
      runExtensionAgentAction({ action: 'pack', source_dir: 'todo-panel' }, { callerWorkspaceRoot: vi.fn().mockResolvedValue(workDir) })
    ).rejects.toThrow(/not packed/);
    expect(inspectDirectory).toHaveBeenCalledWith(path.join(workDir, 'todo-panel'));
    await expect(runExtensionAgentAction({ action: 'pack', source_dir: 'todo-panel' })).rejects.toThrow(
      'source_dir "todo-panel" is relative, and this session has no working copy to take it from; pass an absolute folder'
    );
    expect(inspectDirectory).toHaveBeenCalledTimes(1);
  });

  // S1: app_create takes the manifest's own fields, so the manifest's names are the ones to say.
  it('声明 agents:tools 却没给程序:报错点名 manifest 字段 —— 也就是 app_create 的 manifest 里要写的', async () => {
    await expect(
      runExtensionAgentAction({
        ...minimal,
        target_dir: path.join(workDir, 'tools'),
        manifest: { ...minimal.manifest, permissions: { capabilities: ['agents:tools'] } },
      })
    ).rejects.toThrow(/no contributes\.mcpServers or contributes\.skills/);
  });
});

// 摩擦单 F5(L5,09-29):agent 装完就说「做好了」,页面上其实是「这个标签页没有绑定投票文件」—— 它没法看一眼自己写的
// App 跑没跑起来。app_check 让宿主按给定 context 开一张隐藏页、回读、关掉;这里判分派层:核装没装、开没开、
// 有没有这个 tab,把 context 原样交给宿主,再把回读说成 agent 能照着做的一句话。宿主那半是假的。
describe('app_check', () => {
  const installed = {
    manifest: {
      id: 'dinner-vote',
      name: 'Dinner vote',
      version: '1.0.0',
      contributes: { tabs: [{ name: 'main', title: 'Vote' }, { name: 'admin', title: 'Admin' }] },
    },
  };
  const clean = { loaded: true, loadError: null, errors: [], console: [], snapshot: '- heading "周五吃什么"\n- text: "火锅 2 票"', pages: [], elapsedMs: 840 };
  /** The agent that asks (owner 10-14): the page is its to work. */
  const worker = { callerSessionId: 'session-1', callerAgent: async () => 'user:agent-1' };
  const asked = { caller: 'session-1', operator: { kind: 'agent', id: 'user:agent-1' } };

  it('hands the host the tab and the context as asked, and says a clean run is ok', async () => {
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    const checkSurface = vi.fn(async () => clean);
    const result = (await runExtensionAgentAction(
      { action: 'check', tab_kind: 'dinner-vote.main', chat_id: 'chat-1', item_id: 'item-1' },
      { checkSurface, ...worker },
    )) as { ok: boolean; snapshot: string; next: string };
    expect(checkSurface).toHaveBeenCalledWith({ extensionId: 'dinner-vote', tabName: 'main', chatId: 'chat-1', itemId: 'item-1', timeoutMs: 15_000, ...asked });
    expect(result.ok).toBe(true);
    expect(result.snapshot).toContain('火锅 2 票');
    expect(result).not.toHaveProperty('text');
    expect(result.next).toMatch(/Read snapshot too/);
  });

  it('a page that threw, reported an error or logged one is not ok, and the agent is told not to announce it', async () => {
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    for (const report of [
      { ...clean, errors: [{ kind: 'uncaught' as const, level: 'error' as const, message: 'TypeError: votes is undefined' }] },
      { ...clean, console: [{ level: 'error' as const, message: 'files.open: not-found' }] },
      { ...clean, loaded: false, loadError: 'did-fail-load: main.js 404' },
    ]) {
      const result = (await runExtensionAgentAction(
        { action: 'check', tab_kind: 'dinner-vote.admin' },
        { checkSurface: async () => report, ...worker },
      )) as { ok: boolean; next: string };
      expect(result.ok).toBe(false);
      expect(result.next).toMatch(/Do not tell the person it is done/);
    }
    // 对照:只有 warning 不算坏。
    const warned = (await runExtensionAgentAction(
      { action: 'check', tab_kind: 'dinner-vote.main' },
      { checkSurface: async () => ({ ...clean, console: [{ level: 'warning' as const, message: 'slow' }] }), ...worker },
    )) as { ok: boolean };
    expect(warned.ok).toBe(true);
    // 摩擦单 F62:一条 hint(文件每秒被写太多次)给作者看,不算坏 —— 仍在 errors 里、带着级别。
    const hinted = (await runExtensionAgentAction(
      { action: 'check', tab_kind: 'dinner-vote.main' },
      {
        checkSurface: async () => ({
          ...clean,
          errors: [{ kind: 'reportError' as const, level: 'hint' as const, message: 'gugu: clock.json: written 4.7 times a second with nobody typing' }],
        }),
        ...worker,
      },
    )) as { ok: boolean; errors: { level: string }[] };
    expect(hinted.ok).toBe(true);
    expect(hinted.errors).toEqual([expect.objectContaining({ level: 'hint' })]);
  });

  // 摩擦单 F5(统筹 04:48):check 太早返回 —— 读的时候 App 还在开文件,空壳也回了 ok。宿主等到稳定(加载、第一次 files.open
  // 落定、空闲)才读,超时说卡在哪一步。页面显示什么不在这里猜(F103:「空白」这条猜测在负载下判错了晚出字的页面),文字原样回给 agent。
  it('F5: out of time, it says which step it was still on; what the page shows is read back, not judged', async () => {
    const { checkResult } = await import('./extension-agent-actions');
    const empty = checkResult({ ...clean, snapshot: '' });
    expect(empty.ok).toBe(true);
    expect(empty.snapshot).toBe('');
    const stuck = checkResult({ ...clean, stuck: 'files.open', elapsedMs: 15_020 });
    expect(stuck.ok).toBe(false);
    expect(stuck.stuck).toBe('files.open');
    expect(stuck.next).toMatch(/It did not settle: at 15 s it was still waiting for gugu\.files\.open\(…\) to resolve or reject\./);
  });

  // Owner 10-13: the page is kept for the session to go on with; a tab that claims no file runs as a tab of that session.
  it('page: a tab of no file runs in the caller\'s session, the answer says how to go on, and page goes alone with its steps', async () => {
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    const checkSurface = vi.fn(async () => ({ ...clean, page: 'p-1a2b3c' }));
    const callerSessionId = 'session-1';
    const callerAgent = async () => 'user:agent-1';
    const operator = { kind: 'agent', id: 'user:agent-1' };
    const first = (await runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, { checkSurface, callerSessionId, callerAgent })) as { page?: string; next: string };
    expect(checkSurface).toHaveBeenLastCalledWith({ extensionId: 'dinner-vote', tabName: 'main', sessionId: 'session-1', timeoutMs: 15_000, caller: 'session-1', operator });
    expect(first.page).toBe('p-1a2b3c');
    expect(first.next).toContain('app_check again with page "p-1a2b3c" and more steps goes on from here (it closes 10 min after, or when you app_install again)');
    const steps = [{ press: 'Enter' }];
    await runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', page: 'p-1a2b3c', steps }, { checkSurface, callerSessionId, callerAgent });
    expect(checkSurface).toHaveBeenLastCalledWith(expect.objectContaining({ steps, caller: 'session-1', page: 'p-1a2b3c' }));
    // In a chat it is the chat's page, as asked.
    await runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', chat_id: 'chat-1' }, { checkSurface, callerSessionId, callerAgent });
    expect(checkSurface).toHaveBeenLastCalledWith({ extensionId: 'dinner-vote', tabName: 'main', chatId: 'chat-1', timeoutMs: 15_000, caller: 'session-1', operator });
    for (const where of [{ chat_id: 'chat-1' }, { item_id: 'item-1' }, { file_path: 'a.md' }, { phone: true }]) {
      await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', page: 'p-1a2b3c', steps, ...where }, { checkSurface, callerSessionId, callerAgent }))
        .rejects.toThrow('app_check: a page goes on where it opened, at its size — give page with tab_kind and steps alone');
    }
    // A key press takes only its few keys: refused before anything runs, naming them.
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', steps: [{ click: { role: 'button' } }, { press: 'F5' }] }, { checkSurface, callerSessionId, callerAgent }))
      .rejects.toMatchObject({ code: 'invalid', message: 'app_check: step 2 presses "F5" — press takes Enter, Escape, Tab, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight' });
    // Owner 10-14: the page is the asking agent's to work; a session with no agent, or no session, opens none — never the
    // person's, whose screen it is not on.
    for (const nobody of [{ callerSessionId, callerAgent: async () => null }, {}]) {
      await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, { checkSurface, ...nobody }))
        .rejects.toThrow('app_check: the page is worked by the agent that asks, and none asks here');
    }
    expect(checkSurface).toHaveBeenCalledTimes(3);
  });

  // Owner 10-12: steps go to the host as asked (phone only with them); the check is ok only if every step did what it said.
  it('steps: handed to the host with the size; ok only when each step did what it said, and next says which failed', async () => {
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    const checkSurface = vi.fn(async () => clean);
    const steps = [{ click: { role: 'button', name: '新建投票' } }, { waitFor: { text: '周五吃什么' }, look: true }];
    await runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', chat_id: 'chat-1', steps, phone: true }, { checkSurface, ...worker });
    expect(checkSurface).toHaveBeenCalledWith({ extensionId: 'dinner-vote', tabName: 'main', chatId: 'chat-1', timeoutMs: 15_000, steps, phone: true, ...asked });
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', phone: true }, { checkSurface }))
      .rejects.toThrow('app_check: phone is the size steps run at — give it with steps');
    const { checkResult } = await import('./extension-agent-actions');
    const done = checkResult({ ...clean, steps: [{ step: 1, ok: true, did: 'clicked button "新建投票"' }, { step: 2, ok: true, did: 'saw the text "周五吃什么"' }] });
    expect(done.ok).toBe(true);
    expect(done.steps).toHaveLength(2);
    expect(done.next).toContain('All 2 steps did what they said.');
    const failed = checkResult({
      ...clean,
      steps: [
        { step: 1, ok: false, error: '2 match button "删除"', candidates: ['button "删除" within {"role":"listitem","name":"周五吃什么"}'] },
        { step: 2, ok: null, error: 'not run: step 1 failed' },
      ],
    });
    expect(failed.ok).toBe(false);
    expect(failed.next).toContain('Step 1 failed: 2 match button "删除". A step that names the wrong control is yours to fix');
    expect(failed.next).toMatch(/Do not tell the person it is done/);
    // A step not run (out of time) is not ok either; no steps asked, nothing said of them.
    expect(checkResult({ ...clean, steps: [{ step: 1, ok: null, error: 'not run: the steps\' time was up (0 of 1 done)' }] }).ok).toBe(false);
    expect(checkResult(clean)).not.toHaveProperty('steps');
  });

  // 摩擦单 F68(S16):真页开跑 9 s 就记下了 F62 的 hint,check 拿到的却是 errors: [],agent 就对人说「检查通过」。
  it('F68: what real pages recorded is in errors too — each with its page and how long ago; a real page\'s error is a failure', async () => {
    const { checkResult } = await import('./extension-agent-actions');
    const now = Date.parse('2026-09-30T06:30:00Z');
    const page = { tabKind: 'dinner-vote.main', chatId: 'chat-1', itemId: 'item-1', sessionId: null };
    const hinted = checkResult({
      ...clean,
      pages: [{ at: '2026-09-30T06:29:51Z', level: 'hint', message: 'gugu: board.json: `clock` written 25 times a second: …', page }],
    }, now);
    expect(hinted.ok, 'a hint is advice').toBe(true);
    expect(hinted.errors).toEqual([
      { kind: 'reportError', level: 'hint', message: 'gugu: board.json: `clock` written 25 times a second: …', page: 'dinner-vote.main on file item-1 of chat chat-1', ago: '9 s ago' },
    ]);
    expect(hinted.next).toMatch(/Hints \(advice to you, not failures\): 1 — read them\./);
    const failed = checkResult({ ...clean, pages: [{ at: '2026-09-30T06:10:00Z', level: 'error', message: 'TypeError: x', page: { ...page, itemId: null, chatId: null, sessionId: 'task-9' } }] }, now);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({ page: 'dinner-vote.main in session task-9', ago: '20 min ago' });
    // The check's own page says so too — a thrown error once, though the runtime's reportError carries a copy (Electron E2).
    const own = checkResult({
      ...clean,
      errors: [
        { kind: 'reportError', level: 'error', message: 'Uncaught TypeError: boom (app.js:3)' },
        { kind: 'uncaught', level: 'error', message: 'Uncaught TypeError: boom', source: 'app.js:3', line: "$('board').getContext('2d')" },
        { kind: 'reportError', level: 'error', message: 'Uncaught TypeError: boom (glue.js:9)' },
      ],
    });
    expect(own.errors).toEqual([
      { kind: 'uncaught', level: 'error', message: 'Uncaught TypeError: boom', source: 'app.js:3', line: "$('board').getContext('2d')", page: 'this check' },
      { kind: 'reportError', level: 'error', message: 'Uncaught TypeError: boom (glue.js:9)', page: 'this check' },
    ]);
  });

  // 摩擦单 F69:check 页做了什么照实说给 agent —— 写了几次、presence 几次,还有本来要在人的屏幕上做的事。
  // The rate is a fact, not judged here: whether a file is written every frame is the runtime's F62 hint alone (审计 A3).
  it('F69: what the check’s page did — writes, presence, what it handed back instead of the screen — as facts', async () => {
    const { checkResult } = await import('./extension-agent-actions');
    const readings = { writes: 240, writesPerSecond: 60, presenceSets: 0, presencePerSecond: 0, opens: 1, opensSettled: 1, shown: [] };
    const result = checkResult({ ...clean, readings });
    expect(result).not.toHaveProperty('shown');
    expect(result.next).toContain('During the check it wrote 240 times, at most 60 a second; set presence 0 times, at most 0 a second. ');
    // L3 F69b: what would have reached the person's screen, handed back in order (owner 10-14).
    const shown = [{ verb: 'clipboardWriteText', detail: '{"text":"hi"}' }, { verb: 'notify', detail: '{"title":"Full"}' }];
    const acted = checkResult({ ...clean, readings: { ...readings, shown } });
    expect(acted.shown).toEqual(shown);
    expect(acted.next).toContain('; 2 that would have reached your owner\'s screen came back to you in shown.');
  });

  // The look: an agent had never seen what it made. The pictures go back (as images, by the registrar) and next says to look.
  it('pictures: passed on, and next says to look at them before telling the person; none promised when there are none', async () => {
    const { checkResult } = await import('./extension-agent-actions');
    const pictures = [{ label: '440 wide (a chat\'s side panel), light', mimeType: 'image/jpeg' as const, data: 'AAAA' }];
    const result = checkResult({ ...clean, pictures });
    expect(result.pictures).toEqual(pictures);
    expect(result.next).toContain('Look at the 1 pictures after this text (440 wide (a chat\'s side panel), light): fix what looks wrong');
    expect(result.next).toMatch(/Tell the person it is done only when it works and looks right\.$/);
    // None (the host could not take them — its log says why): none promised.
    const none = checkResult(clean);
    expect(none).not.toHaveProperty('pictures');
    expect(none.next).not.toContain('Look at the');
  });

  // 摩擦单 F94(S23):check 在任务里收 file_path —— 工作副本里的一个文件,页面像认领它的任务 tab 那样打开,走同一场彩排。
  it('F94: in a session, a file of the working copy — the page runs as a tab of the caller\'s session opened for it; never with a chat\'s, never outside', async () => {
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    const repo = path.join(workDir, 'repo');
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'TODO.md'), '- [ ] ship\n');
    const checkSurface = vi.fn(async () => clean);
    const callerWorkspaceRoot = vi.fn().mockResolvedValue(repo);
    const callerSessionId = 'session-1';
    const callerAgent = async () => 'user:agent-1';
    const result = (await runExtensionAgentAction(
      { action: 'check', tab_kind: 'dinner-vote.main', file_path: 'docs/TODO.md' },
      { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(checkSurface).toHaveBeenCalledWith({ extensionId: 'dinner-vote', tabName: 'main', sessionId: 'session-1', filePath: 'docs/TODO.md', timeoutMs: 15_000, caller: 'session-1', operator: { kind: 'agent', id: 'user:agent-1' } });
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: 'docs/TODO.md', item_id: 'item-1' }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .rejects.toThrow('app_check: file_path is a file of your working copy, in a session — give it without chat_id and item_id');
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: '../secrets.txt' }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .rejects.toThrow(/is not a file of your working copy/);
    // L11 R19: the same file by its absolute path (an agent's usual way of naming it) is that file; one outside is not.
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: path.join(repo, 'docs', 'TODO.md') }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .resolves.toMatchObject({ ok: true });
    expect(checkSurface).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1', filePath: 'docs/TODO.md' }));
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: path.join(workDir, 'elsewhere.md') }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .rejects.toThrow(/is not a file of your working copy/);
    // L11 R18: a link in the working copy that points outside it is outside it.
    writeFileSync(path.join(workDir, 'outside.md'), 'not the working copy\n');
    symlinkSync(path.join(workDir, 'outside.md'), path.join(repo, 'docs', 'LINK.md'));
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: 'docs/LINK.md' }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .rejects.toThrow(/is not a file of your working copy/);
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: 'docs/NOPE.md' }, { checkSurface, callerWorkspaceRoot, callerSessionId, callerAgent }))
      .rejects.toThrow('app_check: no file docs/NOPE.md in your working copy');
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main', file_path: 'docs/TODO.md' }, { checkSurface }))
      .rejects.toThrow('app_check: file_path needs a session with a working copy');
    expect(checkSurface).toHaveBeenCalledTimes(2);
  });

  it('says what is wrong before asking the host: not a tab_kind, not installed, switched off, no such tab, no host, a server', async () => {
    const checkSurface = vi.fn(async () => clean);
    // F14 (L7-b) An agent passing the bare id: told what a tab_kind is and where to get one.
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote' }, { checkSurface }))
      .rejects.toThrow(/"dinner-vote" is not a tab_kind .* take it from app_install or app_search/);
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, { checkSurface }))
      .rejects.toThrow(/not installed — app_install it first/);
    list.mockReturnValue({ extensions: [installed], invalid: [] });
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.results' }, { checkSurface }))
      .rejects.toThrow(/no tab "results"; its tab_kinds: dinner-vote.main, dinner-vote.admin/);
    isEnabled.mockReturnValue(false);
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, { checkSurface }))
      .rejects.toThrow(/switched off/);
    isEnabled.mockReturnValue(true);
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, {}))
      .rejects.toThrow(/not available in this build/);
    await expect(runExtensionAgentAction({ action: 'check', tab_kind: 'dinner-vote.main' }, { checkSurface, headless: true }))
      .rejects.toThrow(/Gugu server/);
    expect(checkSurface).not.toHaveBeenCalled();
  });
});

// 摩擦单 F11:群里多人用的 App 从模板起 —— 投票这种 App,agent 只写几十行。
describe('app_create { template: "group-json" }', () => {
  it('writes a group App: claims the group\'s .<id>.json files, asks for nothing, page + style + app.js skeleton', async () => {
    const created = (await runExtensionAgentAction({
      action: 'create',
      target_dir: path.join(workDir, 'vote'),
      id: 'dinner-vote',
      name: 'Dinner <vote>',
      template: 'group-json',
    })) as { source_dir: string; tabs: string[]; next: string };

    const manifest = manifestAt(created.source_dir) as ScaffoldedManifest & { permissions?: unknown };
    expect(manifest.permissions, '不要任何能力:装的时候不弹框').toBeUndefined();
    expect(manifest.contributes.tabs).toEqual([
      { name: 'main', title: 'Dinner <vote>', entry: 'main.html', opensFiles: { chat: ['.dinner-vote.json'] } },
    ]);
    const html = readFileSync(path.join(created.source_dir, 'main.html'), 'utf8');
    expect(html).toContain('<title>Dinner &lt;vote&gt;</title>');
    expect(html).toContain('<script type="module" src="app.js"></script>'); // no inline script: the page's CSP
    const app = readFileSync(path.join(created.source_dir, 'app.js'), 'utf8');
    // F55 The fixed part (opening the file, the status line) is gugu's glue.js, served by the host: app.js is the
    // agent's and imports from it, and the bundle has no copy to fall behind the host or to be missing (App作用域 10-05).
    expect(existsSync(path.join(created.source_dir, 'glue.js'))).toBe(false);
    expect(app).toContain("import { f, me, myName, $, $$, html, render } from '/_gugu/1/glue.js'");
    expect(app).toContain('.dinner-vote.json');
    expect(app).not.toContain('__SUFFIX__');
    expect(existsSync(path.join(created.source_dir, 'style.css'))).toBe(true);
    // S1 rerun: app.js comes back in the answer (four reads saved), with what to leave alone.
    expect((created as unknown as { app_js: string }).app_js).toBe(app);
    expect(created.next).toMatch(/edit its functions, do not rewrite the file: renderShared\(\) draws the file's data into #shared on every change; setup\(\) draws what a person fills in/);
    // L5 S1: the agent read main.html and style.css only to learn the mount points and classes — both are said here; the
    // look itself is the host's now (ui.css), so what is said is how to write for it.
    expect(created.next).toContain("No need to read main.html or style.css; /_gugu/1/glue.js is gugu's (it opens the file and shows offline and errors); gugu's look is already in the page: write semantic HTML");
    expect(created.next).toContain('<gugu-avatar user="…">');
    // F40 The rest is one call: install here + the group's data file + the check on it + the card; nothing to consent to.
    expect(created.next).toContain(`app_install {"source_dir":${JSON.stringify(created.source_dir)},"chat_id":"<the chat>","data":{"title":"<what the chat calls it>","content":<what it starts with, as JSON>}}`);
    expect(created.next).not.toMatch(/Call app_install with this source_dir|workspace_create_document|app_check \{/);
    expect(created.next).toContain('Next time pass app.js in this same call, as files {"app.js": "…"}');
  });

  // 摩擦单 F40(S2:8 次调用,时间几乎全在模型往返):app.js 在 create 这一次就写进去,之后不必 Read + Edit 骨架。
  it('files: the App written in the same call — app.js replaces the skeleton, and the answer does not echo one back', async () => {
    const own = "const f = await gugu.files.open((await gugu.getContext()).file)\ndocument.getElementById('shared').textContent = f.data.question\n";
    const created = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'written'), id: 'dinner-vote', name: 'Dinner vote', template: 'group-json',
      files: { 'app.js': own },
    })) as { source_dir: string; next: string; app_js?: string };
    expect(readFileSync(path.join(created.source_dir, 'app.js'), 'utf8')).toBe(own);
    expect(existsSync(path.join(created.source_dir, 'style.css')), 'the template\'s other files stay').toBe(true);
    expect(created.app_js).toBeUndefined();
    expect(created.next).toMatch(/^The \.dinner-vote\.json files of a chat open in it; your app\.js is in place\. Next: app_install \{/);
    // With own tabs too: the page and its script in the same call, a page wherever its entry says.
    const tabs = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'tabs'), id: 'tabbed', name: 'Tabbed',
      manifest: { contributes: { tabs: [{ name: 'main', title: 'Main', entry: 'pages/main.html' }] } },
      files: { 'pages/main.html': '<script type="module" src="main.js"></script>', 'pages/main.js': 'console.log(1)\n' },
    })) as { source_dir: string };
    expect(readFileSync(path.join(tabs.source_dir, 'pages/main.js'), 'utf8')).toBe('console.log(1)\n');
    expect(manifestAt(tabs.source_dir).contributes.tabs[0]?.entry).toBe('pages/main.html');
  });

  // 摩擦单 F72(S18):第一次就同时给了 template 和 manifest.contributes.tabs,被「exactly one of them」拒掉,白调一次。
  // 以模板为底、manifest 按键盖上去:同名的 tab 合并,新名字加一个 tab。对照组(父提交):两格都拒。
  it('F72: a template and your own tabs are one manifest — the template\'s tab takes yours by name, a new name is a new tab', async () => {
    const merged = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'both'), id: 'board', name: 'Board', template: 'group-json',
      manifest: { contributes: { tabs: [{ name: 'main', title: 'Kanban', toolbar: [{ id: 'reset', title: 'Reset' }] }] } },
    })) as { source_dir: string; tabs: string[] };
    const [main] = manifestAt(merged.source_dir).contributes.tabs;
    expect(main).toMatchObject({ name: 'main', entry: 'main.html', opensFiles: { chat: ['.board.json'] }, toolbar: [{ id: 'reset', title: 'Reset' }] });
    expect((main as { title?: string }).title).toBe('Kanban');
    const added = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'two'), id: 'board2', name: 'Board 2', template: 'group-json',
      manifest: { contributes: { tabs: [{ name: 'admin', title: 'Admin' }] } }, files: { 'admin.html': '<!doctype html>' },
    })) as { source_dir: string; tabs: string[] };
    expect(added.tabs).toEqual(['main', 'admin']);
    expect(manifestAt(added.source_dir).contributes.tabs[1]).toMatchObject({ name: 'admin', entry: 'admin.html' });
    await expect(runExtensionAgentAction({ action: 'create', target_dir: path.join(workDir, 'none'), id: 'none', name: 'None' }))
      .rejects.toThrow('app_create: give a template (a ready-made App) or your own tabs in manifest.contributes.tabs, or both');
  });

  // 摩擦单 F81(S23):target_dir 默认落在工作副本里,App 源码进了人的仓库(`?? kanban-app/`)。不给目录:放到本机的 App 目录,
  // 在工作副本外面,回包写明放在哪;给了目录才照它的来。对照组(父提交):不给 target_dir 被 schema 拒。
  it('F81: no target_dir — the App goes to this computer\'s App folder, outside the working copy, and the answer says where', async () => {
    const apps = path.join(workDir, 'app-sources');
    const callerWorkspaceRoot = vi.fn().mockResolvedValue(path.join(workDir, 'repo'));
    const created = (await runExtensionAgentAction(
      { action: 'create', id: 'kanban', name: 'Kanban', template: 'group-json' },
      { appSourcesRoot: () => apps, callerWorkspaceRoot },
    )) as { source_dir: string; next: string };
    expect(created.source_dir).toBe(path.join(apps, 'kanban'));
    expect(existsSync(path.join(apps, 'kanban', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(workDir, 'repo')), 'nothing in the working copy').toBe(false);
    expect(callerWorkspaceRoot).not.toHaveBeenCalled();
    expect(created.next).toMatch(new RegExp(`^Written to ${path.join(apps, 'kanban').replace(/[\\\\^$.*+?()[\]{}|]/g, '\\\\$&')}, this computer's App folder — outside your working copy\\.`));
    // Again: the same folder, updated in place (F93).
    const again = (await runExtensionAgentAction(
      { action: 'create', id: 'kanban', name: 'Kanban', template: 'group-json', files: { 'app.js': '// mine\n' } },
      { appSourcesRoot: () => apps },
    )) as { source_dir: string; updated?: boolean };
    expect(again).toMatchObject({ source_dir: path.join(apps, 'kanban'), updated: true });
    // A folder named is used as named, as before.
    const named = (await runExtensionAgentAction(
      { action: 'create', target_dir: 'kanban-app', id: 'kanban2', name: 'Kanban 2', template: 'group-json' },
      { appSourcesRoot: () => apps, callerWorkspaceRoot },
    )) as { source_dir: string };
    expect(named.source_dir).toBe(path.join(workDir, 'repo', 'kanban-app'));
  });

  // 摩擦单 F93(S23):再调一次 app_create 改同一个 App,撞「already contains an App bundle」,agent 就另起了一个目录。
  // 同一个 id 原地更新(F72 同一套合并),给了的文件写上、没给的留着;id 不同才拒,并写明怎么办。对照组(父提交):第一格拒。
  it('F93: the same App in the same folder is updated in place — what the call gives laid over what is there', async () => {
    const dir = path.join(workDir, 'vote');
    await runExtensionAgentAction({ action: 'create', target_dir: dir, id: 'vote', name: 'Vote', version: '0.3.0', template: 'group-json' });
    writeFileSync(path.join(dir, 'style.css'), '/* the agent\'s own style */\n');
    const again = (await runExtensionAgentAction({
      action: 'create', target_dir: dir, id: 'vote', name: 'Vote', template: 'group-json',
      files: { 'app.js': "import { f } from '/_gugu/1/glue.js'\n" },
      manifest: { contributes: { tabs: [{ name: 'main', title: 'Friday vote' }] } },
    })) as { source_dir: string; updated?: boolean; next: string };
    expect(again.updated).toBe(true);
    expect(again.next).toMatch(/^Updated in place \(the same App\)/);
    expect(readFileSync(path.join(dir, 'app.js'), 'utf8')).toBe("import { f } from '/_gugu/1/glue.js'\n");
    expect(readFileSync(path.join(dir, 'style.css'), 'utf8'), 'a template file the agent changed stays').toBe('/* the agent\'s own style */\n');
    const manifest = manifestAt(dir) as ScaffoldedManifest & { version: string };
    expect(manifest.version, 'no version given: the one there').toBe('0.3.0');
    expect((manifest.contributes.tabs[0] as { title?: string }).title).toBe('Friday vote');
    expect(manifest.contributes.tabs[0]?.opensFiles).toEqual({ chat: ['.vote.json'] });
    await expect(runExtensionAgentAction({ action: 'create', target_dir: dir, id: 'poll', name: 'Poll', template: 'group-json' }))
      .rejects.toThrow(`app_create: ${dir} holds the App "vote". To change that App, call app_create with id "vote" — the folder is updated in place; for a new App, give another target_dir.`);
    expect(manifestAt(dir).contributes.tabs).toHaveLength(1);
  });

  // S1: the fragment is merged into the manifest create writes — the template's included — and read by its schema.
  it('manifest merges into the template\'s: permissions and a background page join the group App', async () => {
    const created = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'relay'), id: 'chess', name: 'Chess', template: 'group-json',
      manifest: { permissions: { capabilities: ['chat:relay'] }, background: { entry: 'bg.html' } },
      files: { 'bg.html': '<!doctype html>' },
    })) as { source_dir: string; next: string };
    const manifest = manifestAt(created.source_dir) as ScaffoldedManifest & { background?: unknown };
    expect(manifest.permissions).toEqual({ capabilities: ['chat:relay'] });
    expect(manifest.background).toEqual({ entry: 'bg.html' });
    expect(manifest.contributes.tabs[0]?.opensFiles).toEqual({ chat: ['.chess.json'] });
    expect(created.next, 'asks the person at install').toMatch(/chat:relay/);
  });

  // 摩擦单 F114 (S23): {"session":["TODO.md"]} on group-json kept the template's group claim too, and the App claimed both.
  // What opens_files says is the claim, whole; not given, the template's stays. Control (the parent): session + group.
  it.each<[string, unknown, string[], string[]]>([
    ['session named: only the session\'s', { session: ['.todo.json'] }, [], ['.todo.json']],
    ['group named: only the group\'s', { chat: ['.poll.json'] }, ['.poll.json'], []],
    ['both named: both', { session: ['.vote.json'], chat: ['.vote.json'] }, ['.vote.json'], ['.vote.json']],
    ['none: the template\'s', undefined, ['.vote.json'], []],
  ])('opens_files on a template: %s', async (_, opensFiles, group, session) => {
    const created = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'claims'), id: 'vote', name: 'Vote', template: 'group-json',
      opens_files: opensFiles,
    })) as { source_dir: string };
    const tab = manifestAt(created.source_dir).contributes.tabs[0]!;
    expect(claimedSuffixes(tab, 'chat')).toEqual(group);
    expect(claimedSuffixes(tab, 'session')).toEqual(session);
  });

  // 摩擦单 F110(L7 S20 → F105):agent 想认领群里的 catalog.json 和 manual.md,写的是纯数组 —— 纯数组的意思是任务的文件,
  // App 于是也认领了任务文件,F95 那一格就从这里起。只留一种写法:按场合写的对象;纯数组拒掉,说怎么写(apiVersion 2 起 manifest 也一样)。
  it('F110: opens_files as a plain list is refused before anything is written — it says to name the place', async () => {
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'plain'), id: 'store', name: 'Store', template: 'group-json',
      opens_files: ['catalog.json', 'manual.md'],
    })).rejects.toThrow(/opens_files[\s\S]*say where the files are/);
    expect(existsSync(path.join(workDir, 'plain', 'manifest.json'))).toBe(false);
    // Control: the same claim with its place is taken; a manifest refuses a plain list the same way.
    const named = (await runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'named'), id: 'store', name: 'Store', template: 'group-json',
      opens_files: { chat: ['catalog.json', 'manual.md'] },
    })) as { source_dir: string };
    expect(claimedSuffixes(manifestAt(named.source_dir).contributes.tabs[0]!, 'session')).toEqual([]);
    expect(opensFilesSchema.safeParse(['.md']).success).toBe(false);
  });

  it('refuses before writing anything: a page the manifest names that is not in files, a field that is its own parameter, one the manifest does not know', async () => {
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'nopage'), id: 'nopage', name: 'No page',
      manifest: { contributes: { tabs: [{ name: 'main', title: 'Main' }] } },
    })).rejects.toThrow('tab "main"\'s page is main.html, which is not in files');
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'dup'), id: 'dup', name: 'Dup', template: 'group-json', manifest: { version: '2.0.0' },
    })).rejects.toThrow('app_create: version is its own parameter, not a field of manifest');
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: path.join(workDir, 'odd'), id: 'odd', name: 'Odd', template: 'group-json', manifest: { colour: 'red' },
    })).rejects.toThrow(/colour/);
    for (const dir of ['nopage', 'dup', 'odd']) expect(existsSync(path.join(workDir, dir, 'manifest.json'))).toBe(false);
  });
});

describe('app_create { template } with files', () => {
  // 125 10-06 (R's A/B): with a template the agent gave a main.html + main.js of its own; its page replaced the
  // template's, whose app.js nothing loaded — then 7 approvals and 15 minutes of Read / Write / rm to tidy up. Control (the
  // parent commit): written, two Apps in one folder.
  it('a template with its page given in files too is refused, saying where the code goes; nothing is written', async () => {
    const template = 'group-json' as const;
    const dir = path.join(workDir, `two-${template}`);
    await expect(runExtensionAgentAction({
      action: 'create', target_dir: dir, id: 'r-dice', name: 'Dice', template,
      files: { 'main.html': '<script type="module" src="main.js"></script>', 'main.js': '// mine\n' },
    })).rejects.toThrow(`app_create: template "${template}" writes main.html; put your code in files["app.js"], or leave out template`);
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    // Its code and its own CSS are the agent's to give: taken as they are.
    await runExtensionAgentAction({ action: 'create', target_dir: dir, id: 'r-dice', name: 'Dice', template, files: { 'app.js': '// mine\n', 'style.css': 'p {}\n' } });
    expect(readFileSync(path.join(dir, 'app.js'), 'utf8')).toBe('// mine\n');
  });
});

// 摩擦单 F15(L7-d):agent 装好就停,群里其他人手里没有这个 App;告诉它之后,它又叫自己的主人也去点卡片装 ——
// 而主人那台正是它装的那台。装完的 next 说清谁已经有了、谁还没有、下一步是哪一句。
describe('app_install: what comes next', () => {
  const inspectedOf = (tabs: unknown[]) => ({
    manifest: {
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      id: 'dinner-vote', name: 'Dinner vote', version: '1.0.0', contributes: { tabs },
    },
    manifestDigest: 'digest',
  });
  const install = (tabs: unknown[], checkSurface?: () => Promise<never>, chatId?: string) => {
    const inspected = inspectedOf(tabs);
    inspectDirectory.mockReturnValue(inspected);
    installFromDirectory.mockReturnValue({ manifest: inspected.manifest, rootDir: '/installed/dinner-vote' });
    return runExtensionAgentAction(
      { action: 'install', source_dir: path.join(workDir, 'vote'), ...(chatId ? { chat_id: chatId } : {}) },
      { afterInstall: () => undefined, notifyInstalledChanged: async () => undefined, ...(checkSurface ? { checkSurface } : {}) },
    ) as Promise<{ tabs: Array<{ name: string; tab_kind: string }>; next?: string }>;
  };
  const groupTab = { name: 'main', title: 'Vote', entry: 'main.html', opensFiles: { chat: ['.dinner-vote.json'] } };
  const sessionTab = { name: 'main', title: 'Vote', entry: 'main.html', opensFiles: { session: ['.vote'] } };

  it("a group App: check it on a group file, and send it to the group — the owner's computer already has it", async () => {
    const result = await install([groupTab], async () => { throw new Error('not called'); });
    expect(result.tabs).toEqual([{ name: 'main', tab_kind: 'dinner-vote.main', chat_files: ['.dinner-vote.json'] }]);
    expect(result.next).toContain('app_check {"tab_kind":"dinner-vote.main","item_id":"<a file of the chat it opens>"}');
    expect(result.next).toMatch(/Your owner's computer — this one — has it installed now; nobody else in the chat has it yet/);
    expect(result.next).toContain(`app_install {"source_dir":${JSON.stringify(path.join(workDir, 'vote'))},"chat_id":"<the chat>"} again sends it into the chat`);
    // 集体记忆对账第 6 条:进群只有一条路。
    expect(result.next).not.toContain('app_pack');
  });

  // S1 复跑:装和发是一步。带了 chat_id(宿主装完就打包发卡片),next 不再叫它去发。
  it('installed with chat_id: the next says it is in the group already, and asks for no second send', async () => {
    const result = await install([groupTab], async () => { throw new Error('not called'); }, 'chat-1');
    expect(result.next).toMatch(/has it installed, and it is in the chat as a card now/);
    expect(result.next).not.toMatch(/app_pack|nobody else/);
  });

  // 摩擦单 F114① (S23): an App of task files is checked on one of them, as a group App is on a group file (F94); the parent
  // said a bare app_check {"tab_kind"} — the page opened for no file, and the agent skipped the check.
  it('an App of task files: checked on a file of the working copy, not sent anywhere; without a host that checks, no check', async () => {
    const checked = await install([sessionTab], async () => { throw new Error('not called'); });
    expect(checked.next).toContain('app_check {"tab_kind":"dinner-vote.main","file_path":"<a file of your working copy it opens>"}');
    expect(checked.next).not.toMatch(/app_pack|the chat|chat_id/);
    const unchecked = await install([sessionTab]);
    expect(unchecked.next).toBeUndefined();
    const groupUnchecked = await install([groupTab]);
    expect(groupUnchecked.next).not.toMatch(/app_check/);
    // 集体记忆对账第 6 条:进群只指 app_install 带 chat_id 这一条路。
    expect(groupUnchecked.next).toMatch(/"chat_id":"<the chat>"\} again sends it into the chat/);
  });

  // 5-minute game rounds 2-3 (10-29): a group App made in another chat is installed here; app_install { app } sends it on.
  it('an App installed here (app): nothing is installed again, its tabs come back, the next says it is in the chat', async () => {
    installFromDirectory.mockClear();
    list.mockReturnValue({ extensions: [{ manifest: inspectedOf([groupTab]).manifest, rootDir: '/installed/dinner-vote' }], invalid: [] });
    const result = await runExtensionAgentAction({ action: 'install', app: 'dinner-vote', chat_id: 'chat-1' }, {}) as { installed: boolean; id: string; tabs: unknown; next?: string };
    expect(result).toMatchObject({ installed: true, id: 'dinner-vote', tabs: [{ name: 'main', tab_kind: 'dinner-vote.main', chat_files: ['.dinner-vote.json'] }] });
    expect(result.next).toMatch(/has it installed, and it is in the chat as a card now/);
    expect(installFromDirectory).not.toHaveBeenCalled();
    await expect(runExtensionAgentAction({ action: 'install', app: 'not-here', chat_id: 'chat-1' }, {}))
      .rejects.toThrow('App not-here is not installed on this computer');
  });
});

// App 市场方案 10-07: an agent installs from the market the way the Apps page's 安装 does — this machine's version fetched,
// checked and unpacked (`materialize`), then the same install as the market's App, the sheet saying where its code is.
describe('app_install { market }', () => {
  const reader = {
    id: 'reader', name: 'Reader', version: '1.2.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'main.html',
    permissions: { capabilities: ['files:read'] },
    contributes: { tabs: [{ name: 'main', title: 'Read', entry: 'main.html' }] },
  };
  const source = { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) };
  const offered = (manifest: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ manifest, version: manifest.version, compat: null, source, ...extra }) as never;
  const marketWith = (byId: Record<string, unknown>, found: unknown[] = []) => ({
    entry: vi.fn(async (id: string) => (byId[id] ?? null) as never),
    list: vi.fn(async () => ({ extensions: found, total: found.length, hasMore: false }) as never),
    // What the market recorded for the version it unpacked: where its code is comes back with the folder.
    materialize: vi.fn(async (id: string) => ({ sourceDir: `/tmp/market-staged/${id}`, source, releaseNotes: 'notes', sha256: 'a'.repeat(64), bytes: 42 })),
    hold: vi.fn(),
    held: vi.fn(async () => null),
    // The unpacked copy is done with once it is installed (or refused): let go of, never left in staging.
    discard: vi.fn(),
  });
  const quietly = { notifyInstalledChanged: vi.fn().mockResolvedValue(undefined), afterInstall: vi.fn() };

  it('reads a device-scoped market App before it is installed (L11)', async () => {
    const market = marketWith({ reader: offered(reader) });
    expect(await runExtensionAgentAction({ action: 'manage', operation: 'read', url: 'gugu://app/reader?device=00000000-0000-4000-8000-000000000001' }, { market })).toMatchObject({ manifest: reader });
    expect(market.entry).toHaveBeenCalledWith('reader');
  });

  it("fetches this machine's version, asks with where its code is, and installs it as the market's — not the agent's folder", async () => {
    const market = marketWith({ reader: offered(reader) });
    inspectDirectory.mockReturnValue({ manifest: reader, manifestDigest: 'digest-m' });
    installFromDirectory.mockReturnValue({ manifest: reader, rootDir: '/installed/reader' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });

    const result = await runExtensionAgentAction({ action: 'install', market: 'reader' }, { ...quietly, market, requestInstallConsent });

    expect(market.materialize).toHaveBeenCalledWith('reader', '1.2.0', expect.any(Function));
    expect(requestInstallConsent).toHaveBeenCalledWith(expect.objectContaining({
      sourceDir: '/tmp/market-staged/reader',
      manifestDigest: 'digest-m',
      // What this version changed goes on the sheet too (the Apps page's sheet said it; now every place's does).
      market: { source, releaseNotes: 'notes' },
    }));
    // A market App is gugu's: no folder publisher.
    expect(installFromDirectory).toHaveBeenCalledWith('/tmp/market-staged/reader', 'digest-m', 'market', undefined, undefined);
    expect(market.discard).toHaveBeenCalledWith(expect.objectContaining({ sourceDir: '/tmp/market-staged/reader' }));
    expect(result).toMatchObject({ installed: true, id: 'reader', version: '1.2.0' });
  });

  // owner 10-19 (VS Code's `--install-extension id@version`): that version, not this machine's; an older one stays there.
  it('`<id>@<version>` installs that version; older than the market gives this machine, it says the App stays at it', async () => {
    const older = { ...reader, version: '1.1.0' };
    const market = marketWith({ reader: offered(reader) });
    inspectDirectory.mockReturnValue({ manifest: older, manifestDigest: 'digest-o' });
    installFromDirectory.mockReturnValue({ manifest: older, rootDir: '/installed/reader' });
    setAutoUpdate.mockClear();
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });

    const result = await runExtensionAgentAction({ action: 'install', market: 'reader@1.1.0' }, { ...quietly, market, requestInstallConsent });

    expect(market.materialize).toHaveBeenCalledWith('reader', '1.1.0', expect.any(Function));
    expect(setAutoUpdate).toHaveBeenCalledWith('reader', false);
    expect(result).toMatchObject({ installed: true, id: 'reader', version: '1.1.0' });
    expect((result as { next?: string }).next).toMatch(/^reader stays at 1\.1\.0: it is no longer updated by itself/);

    // Control: without a version, this machine's (1.2.0) — nothing pinned, nothing said about it.
    installFromDirectory.mockReturnValue({ manifest: reader, rootDir: '/installed/reader' });
    inspectDirectory.mockReturnValue({ manifest: reader, manifestDigest: 'digest-m' });
    setAutoUpdate.mockClear();
    const plain = await runExtensionAgentAction({ action: 'install', market: 'reader' }, { ...quietly, market: marketWith({ reader: offered(reader) }), requestInstallConsent });
    expect(setAutoUpdate).not.toHaveBeenCalled();
    expect((plain as { next?: string }).next ?? '').not.toMatch(/stays at/);
  });

  it("a name its card shows finds it when the market's search finds exactly one; more than one names them, none says so", async () => {
    inspectDirectory.mockReturnValue({ manifest: reader, manifestDigest: 'digest-m' });
    installFromDirectory.mockReturnValue({ manifest: reader, rootDir: '/installed/reader' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    const one = marketWith({}, [offered(reader)]);
    await runExtensionAgentAction({ action: 'install', market: 'Reader' }, { ...quietly, market: one, requestInstallConsent });
    expect(one.list).toHaveBeenCalledWith({ search: 'Reader' });
    expect(one.materialize).toHaveBeenCalledWith('reader', '1.2.0', expect.any(Function));

    const two = marketWith({}, [offered(reader), offered({ ...reader, id: 'reader-pro', name: 'Reader Pro' })]);
    await expect(runExtensionAgentAction({ action: 'install', market: 'Reader' }, { ...quietly, market: two, requestInstallConsent }))
      .rejects.toThrow(/matches 2 Apps in the market: reader \(Reader\), reader-pro \(Reader Pro\) — pass market with one of these ids/);
    expect(two.materialize).not.toHaveBeenCalled();

    const none = marketWith({}, []);
    await expect(runExtensionAgentAction({ action: 'install', market: 'Nope' }, { ...quietly, market: none, requestInstallConsent }))
      .rejects.toThrow(/the market has no App "Nope"/);
  });

  // 10-14, the owner's 日历 0.4.2: published while gugu ran, and app_install said "the market has no App" — it read the
  // index the Apps page had taken, until someone opened that page again. The real market here, its index changed under it.
  it('an App published after the Apps page took the index installs — by its id and by its name', async () => {
    const versionOf = (manifest: typeof reader) => ({
      version: manifest.version, manifest, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: 'notes',
      publishedAt: '2026-10-14T00:00:00Z', sha256: 'a'.repeat(64), bytes: 1, bundle: `bundles/${manifest.id}/${manifest.version}.zip`,
      icon: null, readme: null, source, yanked: null,
    });
    const other = { ...reader, id: 'other', name: 'Other' };
    let index: { apps: unknown[] } = { apps: [] };
    const site = {
      readText: async () => JSON.stringify(index),
      download: async (): Promise<Uint8Array> => { throw new Error('the bundle is not fetched here'); },
      urlOf: (relativePath: string) => relativePath,
    };
    const appsPageThenPublish = async () => {
      const market = new CloudExtensionMarket(site, {
        stagingRoot: path.join(workDir, 'staging'),
        heldRoot: path.join(workDir, 'held'),
        resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
        snapshotStore: { read: async () => null, write: async () => undefined },
      });
      index = { apps: [{ id: 'other', deprecated: null, versions: [versionOf(other)] }] };
      await market.list();
      index = { apps: [...index.apps, { id: 'reader', deprecated: null, versions: [versionOf(reader)] }] };
      // The copy the Apps page took still has no Reader: the case reproduces.
      expect((await market.list({ search: 'reader' })).total).toBe(0);
      vi.spyOn(market, 'materialize').mockResolvedValue({ sourceDir: '/tmp/market-staged/reader', source, releaseNotes: 'notes', sha256: 'a'.repeat(64), bytes: 42 });
      return market;
    };
    inspectDirectory.mockReturnValue({ manifest: reader, manifestDigest: 'digest-m' });
    installFromDirectory.mockReturnValue({ manifest: reader, rootDir: '/installed/reader' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });

    for (const asked of ['reader', 'Reader']) {
      const market = await appsPageThenPublish();
      await expect(runExtensionAgentAction({ action: 'install', market: asked }, { ...quietly, market, requestInstallConsent }))
        .resolves.toMatchObject({ installed: true, id: 'reader', version: '1.2.0' });
      expect(market.materialize).toHaveBeenCalledWith('reader', '1.2.0', expect.any(Function));
    }
  });

  // The real market: the one check is where every install path fetches it (materialize), before the download.
  it('a version this machine cannot install says what to do, and nothing is fetched', async () => {
    const download = vi.fn(async (): Promise<Uint8Array> => { throw new Error('the bundle is not fetched here'); });
    const index = { apps: [{ id: 'reader', deprecated: null, versions: [{
      version: reader.version, manifest: reader, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.3.0', releaseNotes: 'notes',
      publishedAt: '2026-10-14T00:00:00Z', sha256: 'a'.repeat(64), bytes: 1, bundle: `bundles/reader/${reader.version}.zip`,
      icon: null, readme: null, source, yanked: null,
    }] }] };
    const market = new CloudExtensionMarket({ readText: async () => JSON.stringify(index), download, urlOf: (relativePath: string) => relativePath }, {
      stagingRoot: path.join(workDir, 'staging'),
      heldRoot: path.join(workDir, 'held'),
      resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
      snapshotStore: { read: async () => null, write: async () => undefined },
    });
    await expect(runExtensionAgentAction({ action: 'install', market: 'reader' }, { ...quietly, market }))
      .rejects.toThrow(/needs gugu 0\.3\.0 or newer — ask the person to update gugu/);
    expect(download).not.toHaveBeenCalled();
    expect(installFromDirectory).not.toHaveBeenCalled();
  });

  it("the one rule: the market's update of the market's copy asking for nothing new goes in without asking; a folder's does not", async () => {
    const v1 = { ...reader, version: '1.0.0' };
    list.mockReturnValue({ extensions: [{ manifest: v1 }], invalid: [] });
    origins.mockReturnValue({ reader: 'market' });
    inspectDirectory.mockReturnValue({ manifest: reader, manifestDigest: 'digest-m' });
    installFromDirectory.mockReturnValue({ manifest: reader, rootDir: '/installed/reader' });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await expect(runExtensionAgentAction({ action: 'install', market: 'reader' }, { ...quietly, market: marketWith({ reader: offered(reader) }), requestInstallConsent }))
      .resolves.toMatchObject({ installed: true, outcome: 'confirmed' });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    // E-05: a folder over the market's copy is the person's call however little it asks.
    await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/reader-folder' }, { ...quietly, requestInstallConsent }))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
  });

  it('takes exactly one of a folder, a market App or an installed App', async () => {
    await expect(runExtensionAgentAction({ action: 'install', source_dir: '/tmp/x', market: 'reader' }, quietly))
      .rejects.toThrow(/exactly one of source_dir, source_message_id, market or app/);
    await expect(runExtensionAgentAction({ action: 'install', market: 'reader', app: 'reader', chat_id: 'chat-1' }, quietly))
      .rejects.toThrow(/exactly one of source_dir, source_message_id, market or app/);
    await expect(runExtensionAgentAction({ action: 'install' }, quietly))
      .rejects.toThrow(/exactly one of source_dir, source_message_id, market or app/);
  });

  it('a group App from the market: the call that sends it into the chat names the market, never a folder', async () => {
    const vote = {
      id: 'dinner-vote', name: 'Dinner vote', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'main.html',
      contributes: { tabs: [{ name: 'main', title: 'Vote', entry: 'main.html', opensFiles: { chat: ['.dinner-vote.json'] } }] },
    };
    inspectDirectory.mockReturnValue({ manifest: vote, manifestDigest: 'digest-v' });
    installFromDirectory.mockReturnValue({ manifest: vote, rootDir: '/installed/dinner-vote' });
    const result = await runExtensionAgentAction(
      { action: 'install', market: 'dinner-vote' },
      { ...quietly, market: marketWith({ 'dinner-vote': offered(vote) }) },
    ) as { next?: string };
    expect(result.next).toContain('app_install {"market":"dinner-vote","chat_id":"<the chat>"} again sends it into the chat');
    expect(result.next).not.toMatch(/source_dir|market-staged/);
  });
});
