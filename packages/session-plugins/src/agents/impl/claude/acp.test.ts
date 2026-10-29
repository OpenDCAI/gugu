import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { AcpClientFactory } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import {
  NODE_FOR_CLAUDE_ACP,
  clearNodeInterpreterCache,
  satisfies,
} from '../../helpers/node-interpreter';
import {
  CLAUDE_ACP_FORK_PATCH_MARKERS,
  CLAUDE_ACP_STEERING_PATCH_MARKERS,
  CLAUDE_ACP_CONTEXT_WINDOW_PATCH_MARKERS,
  CLAUDE_ACP_V2_EXTENSION_MARKERS,
} from './index';
import { pluginRegistry } from '../../registry';

describe('claude acp capability', () => {
  it('declares acp: { kind: supported }', () => {
    const claude = pluginRegistry.get('claude');
    expect(claude).toBeDefined();
    expect(claude!.capabilities.acp.kind).toBe('supported');
  });

  it('declares UltraCode as a Claude effort choice', () => {
    const effort = pluginRegistry.get('claude')!.capabilities.effort;
    expect(effort.kind).toBe('selectable');
    if (effort.kind !== 'selectable') return;
    expect(effort.effortOptions.ultracode).toEqual({
      name: 'UltraCode',
      description: '极高推理并按需编排动态工作流',
    });
  });

  it('all non-ACP plugins default acp to { kind: none }', () => {
    // @@@gugu-refresh — 这份白名单是上游的,且**在上游那边就已经陈旧**:上游后来给 10 个 provider
    // (antigravity / commandcode / zero / rovo / charm / amp / letta / autohand / oh-my-pi /
    // continue)加了 ACP 支持却没更新这里,而上游 CI 从不跑测试,所以一直没人发现。咕咕把 vitest
    // 搬上 CI(#2538)后第一轮就撞到了。
    // 2026-09-21(#6097):其中 rovo / charm / letta / autohand / goose 五家的插件被整个删掉,
    // 一并从这份名单里划掉 —— 留着不会红(循环只看注册表里的家),那正是它该走的理由:
    // 一条永不命中的豁免会让人以为它还在豁免什么。
    // ❌ 不要改成「从 registry 推导」——那会让断言变成自证(用同一个数据源校验它自己)。这条测试
    // 的价值恰恰是「谁把某个 provider 翻成 ACP,必须自觉来改这一行」,所以保留硬编码、只刷新内容。
    const acpProviders = new Set([
      'amp',
      'antigravity',
      'auggie',
      'claude',
      'cline',
      'codebuddy',
      'codex',
      'commandcode',
      'continue',
      'copilot',
      'cursor',
      'devin',
      'droid',
      'gemini',
      'grok',
      'hermes',
      'junie',
      'kilocode',
      'kimi',
      'kiro',
      'mimocode',
      'mistral',
      'oh-my-pi',
      'opencode',
      'pi',
      'qoder',
      'qwen',
      'zcode',
      'zero',
    ]);
    for (const p of pluginRegistry.getAll()) {
      if (acpProviders.has(p.metadata.id)) continue;
      expect(p.capabilities.acp.kind).toBe('none');
    }
  });
});

describe('claude acp behavior', () => {
  const claude = () => pluginRegistry.get('claude')!;
  const acpBehavior = () => claude().behavior.acp!;

  it('behavior.acp is defined', () => {
    expect(acpBehavior()).toBeDefined();
  });

  describe('buildSpawn', () => {
    // 桥入口由宿主按 `acp.bridge` 声明解析好递进来(#6394);这里替宿主给一份。
    const spawnCtx = {
      cwd: '/home/user/worktrees/task-1',
      env: {},
      cli: '/usr/local/bin/claude',
      adapterEntry: '/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    };

    it('passes CLAUDE_CODE_EXECUTABLE from ctx.cli', () => {
      const result = acpBehavior().buildSpawn(spawnCtx);
      expect(result.env?.CLAUDE_CODE_EXECUTABLE).toBe('/usr/local/bin/claude');
    });

    it('sets ELECTRON_RUN_AS_NODE=1', () => {
      const result = acpBehavior().buildSpawn({ ...spawnCtx, cli: '/x/claude' });
      expect(result.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    });

    // 桥在 root 下不报 `bypassPermissions`,「完全访问」就没档可落(取证与 A/B 见 ./root-bypass.ts)。
    // ⚠️ 断言写成**与本机 euid 的等价关系**,❌ 不是硬编码某一侧:测试既在 root 的开发机上跑,
    // 也在普通用户身份的 CI 上跑。两边各钉住一个方向 —— 漏接线(root 上没有)与无条件注入
    // (非 root 上有)都会被抓。
    it('只在以 root 运行时给桥解锁 bypassPermissions', () => {
      const result = acpBehavior().buildSpawn(spawnCtx);
      const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0;
      expect(result.env?.IS_SANDBOX).toBe(isRoot ? '1' : undefined);
    });

    // @@@sessionpage claude-acp-node — 宿主钉的 Electron 可能自带过老的 node(gugu: Electron 28 = Node
    // 18.18),而 adapter 用了 import attributes(需 ≥20.10)→ 进程一起来就 SyntaxError。所以这里挑的
    // 不是「某个固定路径」,而是**真的够新**的那一个 —— 判据只能是解释器自己报的版本。
    it('挑出来的解释器真的满足 adapter 的最低版本要求', () => {
      const command = acpBehavior().buildSpawn(spawnCtx).command;
      const reported = execFileSync(command, ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }).trim();
      expect(satisfies(reported, NODE_FOR_CLAUDE_ACP)).toBe(true);
    });

    // 最低版本以桥接自己的声明为准,❌ 由咕咕按某个语法特性自行放宽(#6394)。
    it('要求的 node 版本与桥接 package.json 的 engines.node 一致', () => {
      const require_ = createRequire(import.meta.url);
      const pkg = JSON.parse(readFileSync(
        require_.resolve('@agentclientprotocol/claude-agent-acp/package.json'),
        'utf8',
      )) as { engines?: { node?: string } };
      expect(pkg.engines?.node).toBe(`>=${NODE_FOR_CLAUDE_ACP.major}`);
    });

    // 宿主/用户把自己解析好的 node 路径放进 GUGU_NODE_BIN,这里必须优先用它。
    // 钉一个「确实存在、确实够新、又确实不在 PATH 上」的路径 —— 拿一个真 node 的软链最省事;
    // ❌ 写死 /opt/homebrew/bin/node 之类:那在有 homebrew 的机器上绿、别的机器上红,
    // 绿的那一半还不是因为「优先级对」,而是因为那台恰好装了它。
    it('prefers the host-provided GUGU_NODE_BIN over everything else', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gugu-node-bin-'));
      const pinned = join(dir, 'pinned-node');
      symlinkSync(process.execPath, pinned);
      const original = process.env.GUGU_NODE_BIN;
      process.env.GUGU_NODE_BIN = `  ${pinned}  `;
      clearNodeInterpreterCache();
      try {
        expect(acpBehavior().buildSpawn(spawnCtx).command).toBe(pinned);
      } finally {
        if (original === undefined) delete process.env.GUGU_NODE_BIN;
        else process.env.GUGU_NODE_BIN = original;
        clearNodeInterpreterCache();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('空白的 GUGU_NODE_BIN 等于没设,照常解析出一个够新的解释器', () => {
      const original = process.env.GUGU_NODE_BIN;
      process.env.GUGU_NODE_BIN = '   ';
      clearNodeInterpreterCache();
      try {
        const command = acpBehavior().buildSpawn(spawnCtx).command;
        expect(command.trim()).not.toBe('');
        expect(existsSync(command)).toBe(true);
      } finally {
        if (original === undefined) delete process.env.GUGU_NODE_BIN;
        else process.env.GUGU_NODE_BIN = original;
        clearNodeInterpreterCache();
      }
    });

    it('spawns exactly the bridge entry the host resolved', () => {
      const result = acpBehavior().buildSpawn(spawnCtx);
      expect(result.args[0]).toBe(spawnCtx.adapterEntry);
    });

    it('declares its bridge (paired with the Claude version) and refuses to guess one', () => {
      expect(acpBehavior().bridge).toEqual({
        kind: 'package',
        alias: '@agentclientprotocol/claude-agent-acp',
        entry: 'dist/index.js',
        pairWith: 'claude',
      });
      // 阴控:宿主没递入口 ⇒ 当场报错,❌ 插件自己再 require.resolve 一份(#5050 的「两个 adapter」)。
      const { adapterEntry: _omit, ...withoutEntry } = spawnCtx;
      expect(() => acpBehavior().buildSpawn(withoutEntry)).toThrow(/adapterEntry/);
    });
  });

  describe('connect', () => {
    it('returns an object with prompt and newSession methods', () => {
      const stdin = new Writable({ write: (_c, _e, cb) => cb() });
      const stdout = new Readable({ read: () => {} });

      const toClient: AcpClientFactory = () => ({
        sessionEvent: vi.fn(),
        requestPermission: vi.fn(),
        sessionUpdate: vi.fn(),
      });

      const agentApi = acpBehavior().connect({ stdin, stdout }, toClient);
      expect(typeof agentApi.prompt).toBe('function');
      expect(typeof agentApi.newSession).toBe('function');
      expect(typeof agentApi.initialize).toBe('function');
    });
  });
});

describe('claude acp vendor boundary', () => {
  function vendorAgentEntry(): string {
    const require_ = createRequire(import.meta.url);
    return require_
      .resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
      .replace(/[/\\]index\.js$/, '/acp-agent.js');
  }

  // @@@acp-fork-patch (#5599 · #6394) — 咕咕要的桥接改动是 fork 里的源码提交,依赖直接指向 fork 构建,
  // ❌ 不在运行时就地改写装好的包(AppImage 的 resources/app 是只读 squashfs,那一写必 EROFS),
  // ❌ 也不再用 pnpm 补丁改发布产物。换版守卫就落在这里:换进一份不含这些提交的桥接 → 这条红。
  it('ships the fork and steering commits inside the resolved vendor adapter', () => {
    const agentEntry = vendorAgentEntry();
    const source = readFileSync(agentEntry, 'utf8');
    for (const marker of [
      ...CLAUDE_ACP_FORK_PATCH_MARKERS,
      ...CLAUDE_ACP_STEERING_PATCH_MARKERS,
      ...CLAUDE_ACP_CONTEXT_WINDOW_PATCH_MARKERS,
    ]) {
      expect(source, `missing fork commit marker in ${agentEntry}: ${marker}`).toContain(marker);
    }
    // 1.1.0 那版的分叉 id 改动(把 id 交给 Claude 铸)还在 = 换进了一份旧桥接,分叉的更新会被丢(#6552)。
    expect(source).not.toContain('sessionId = initializedSessionId;');
  });

  it('ships the ACP v2 steering and async task commits that the v2 host drives', () => {
    const dist = dirname(vendorAgentEntry());
    for (const [file, markers] of Object.entries(CLAUDE_ACP_V2_EXTENSION_MARKERS)) {
      const source = readFileSync(join(dist, file), 'utf8');
      for (const marker of markers) {
        expect(source, `missing v2 commit marker in ${file}: ${marker}`).toContain(marker);
      }
    }
  });

  it('ships the UltraCode adapter mapping and toggles it independently from ordinary effort', async () => {
    const effortEntry = vendorAgentEntry().replace(/acp-agent\.js$/, 'session-effort.js');
    const vendor = await import(pathToFileURL(effortEntry).href) as {
      effortFlagSettings(value: string | undefined, previous: string | undefined): {
        ultracode?: boolean;
        effortLevel: string | null;
      };
      buildEffortConfigOption(
        modelInfos: Array<{ value: string; supportsEffort: boolean; supportedEffortLevels: string[] }>,
        currentModelId: string,
        currentEffortLevel: string | undefined,
        useRecommendedValue: boolean,
      ): { currentValue?: unknown; options?: Array<{ value: string }> } | undefined;
    };
    expect(vendor.effortFlagSettings('ultracode', 'high')).toEqual({
      ultracode: true,
      effortLevel: null,
    });
    // 离开 UltraCode 必须在同一次 flag update 里显式关掉它。
    expect(vendor.effortFlagSettings('high', 'ultracode')).toEqual({
      ultracode: false,
      effortLevel: 'high',
    });
    expect(vendor.effortFlagSettings('default', 'ultracode')).toEqual({
      ultracode: false,
      effortLevel: null,
    });

    const xhigh = [{ value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'xhigh'] }];
    const effortOption = vendor.buildEffortConfigOption(xhigh, 'sonnet', 'ultracode', false);
    expect(effortOption?.currentValue).toBe('ultracode');
    expect(effortOption?.options?.map((option) => option.value)).toContain('ultracode');

    const noXhigh = [{ value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }];
    const noXhighOption = vendor.buildEffortConfigOption(noXhigh, 'sonnet', undefined, false);
    expect(noXhighOption?.options?.map((option) => option.value)).not.toContain('ultracode');
  });
});
