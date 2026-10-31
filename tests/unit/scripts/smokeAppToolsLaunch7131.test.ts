import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extensionAgentPrograms, type ExtensionAgentContribution } from '../../../apps/desktop/electron/extension-session-mcp';
import { launchOf } from '../../../scripts/gugu-server/smoke-app-tools.mts';

/*
 * #7131 出包冒烟照抄产品的两样东西,抄的那一份不跟,冒烟就悄悄失去意义(2026-10-11 评审第 1、2 节):
 * 1. smoke-app-tools.mts 起预装 App 程序的样子 —— 产品哪天多要一样东西(参数、环境变量、stdio 约定),冒烟没跟就照样绿,
 *    产品却起不来。这里拿每个预装 App 真实的 manifest,把 launchOf 和 extensionAgentPrograms 逐项比。
 * 2. ci-linux-packages.sh grep 的那句「替身缺成员」提示 —— server-entry.ts 改了措辞,grep 就悄悄不命中。
 */

const repoRoot = join(__dirname, '../../..');
const appsDir = join(repoRoot, 'apps/desktop/preinstalled-apps');
// What the package ships, and one App written for this test: a program started with `command: "node"` (no preinstalled App
// has one since 全能搜索 went to the market, 10-16) — the smoke starts what a package ships, so that way must stay held to the product.
const apps = [
  ...readdirSync(appsDir).filter((name) => existsSync(join(appsDir, name, 'manifest.json'))).map((name) => ({ appId: name, root: join(appsDir, name) })),
  { appId: 'smoke-node-app', root: join(__dirname, 'fixtures/smoke-node-app') },
];
const NODE = '/srv/gugu/node/bin/node';
const PROGRAM_RUNTIME = '/srv/gugu/app/dist-electron/app-runtime/7/gugu-program.mjs';
const TOOLS_RUNTIME = '/srv/gugu/app/dist-electron/app-runtime/7/gugu-tools.mjs';
const LINK_PREFIX = 'gugu://ext';

describe('the server package smoke starts preinstalled Apps\' programs as gugu does (#7131)', () => {
  it('every program of every preinstalled App: the same executable, arguments, env, cwd, and gugu\'s node with IPC exactly when gugu uses it', () => {
    // Programs compared, by how gugu starts them: a tools module (`gugu-tools.mjs <module>`) or `command: "node"`.
    const compared = { tools: 0, node: 0 };
    for (const { appId, root } of apps) {
      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
        name: string;
        contributes?: { mcpServers?: ExtensionAgentContribution['servers'] };
      };
      const servers = manifest.contributes?.mcpServers ?? [];
      const dataDir = `/data/${appId}`;
      const { programs } = extensionAgentPrograms(
        [{ extensionId: appId, name: manifest.name, rootDir: root, dataDir, digest: 'd', disclosure: 'progressive', servers, skillsDir: null }],
        { nodeExecutable: NODE, toolsRuntime: TOOLS_RUNTIME, linkPrefix: LINK_PREFIX, onProblem: (message) => { throw new Error(message); } },
      );
      expect(programs).toHaveLength(servers.length);
      servers.forEach((server, index) => {
        const product = programs[index]!;
        if ('host' in server) {
          expect(product.native).toBe(server.host);
          return;
        }
        const smoke = launchOf(appId, root, server, { node: NODE, programRuntime: PROGRAM_RUNTIME, toolsRuntime: TOOLS_RUNTIME, dataDir, linkPrefix: LINK_PREFIX });
        if (!product.onGuguNode) {
          // Not on gugu's node (npx, uvx…): a clean server has none of them, the smoke skips it.
          expect(smoke).toBeNull();
          return;
        }
        compared['tools' in server ? 'tools' : 'node'] += 1;
        expect(smoke).toEqual({
          command: product.command,
          // OwnedStdioTransport: a program on gugu's node gets the App runtime first, and the IPC slot.
          args: ['--import', pathToFileURL(PROGRAM_RUNTIME).href, ...product.args],
          env: product.env,
          cwd: product.cwd,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          serialization: 'advanced',
          detached: true,
        });
      });
    }
    // Both ways were compared at least once: a way nothing here uses any more would pass any drift in it unseen (PR-2 评审
    // 10-13) — the tools module is the workspace's, the node program the fixture's.
    expect(compared.tools).toBeGreaterThan(0);
    expect(compared.node).toBeGreaterThan(0);
  });

  it('run from the command line it still smokes — a package with no App runtime is red, never a silent pass', () => {
    // The script only smokes when it is the program node runs (imported, it gives launchOf alone): a check that never
    // matches would turn every package green without starting anything (on macOS /tmp is /private/tmp).
    // Run through a symlink, as a path with one in it is: node runs the real file.
    const empty = mkdtempSync(join(tmpdir(), 'smoke-7131-'));
    try {
      symlinkSync(join(repoRoot, 'scripts/gugu-server/smoke-app-tools.mts'), join(empty, 'smoke.mjs'));
      const run = spawnSync(process.execPath, [join(empty, 'smoke.mjs'), empty], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('::error::包里的 App 运行时不是恰好一份');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('the line ci-linux-packages.sh greps for is the one server-entry.ts writes when the shim lacks an electron member', () => {
    const ci = readFileSync(join(repoRoot, 'scripts/gugu-server/ci-linux-packages.sh'), 'utf8');
    const greps = [...ci.matchAll(/grep -h "([^"]*server-electron-shim[^"]*)"/g)].map((match) => match[1]!);
    expect(greps).toEqual(['未在 server-electron-shim.ts 覆盖']);
    const entry = readFileSync(join(repoRoot, 'apps/desktop/electron/server-entry.ts'), 'utf8');
    // The stderr line itself, not a comment that happens to quote it.
    const said = [...entry.matchAll(/stderr\(`([^`]*)`\)/g)].map((match) => match[1]!);
    expect(said.filter((line) => line.includes(greps[0]!))).toHaveLength(1);
  });
});
