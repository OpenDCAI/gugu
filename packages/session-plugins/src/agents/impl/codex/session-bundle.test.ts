import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  materializeCodexSessionBundle,
} from './session-bundle';

const ctx = { surface: 'acp' as const, lifecycle: 'fresh' as const, cwd: '/work' };

function bundle(overrides: Partial<SessionCapabilityBundle> = {}): SessionCapabilityBundle {
  return {
    mcpServers: [],
    env: { GUGU_HOME: '/gugu' },
    model: {
      dialect: 'codex-config-flags',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
    },
    autonomy: null,
    promptBlocks: {},
    packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
    ...overrides,
  };
}

describe('Codex ACP reasoning summary settings', () => {
  it('requests the official auto reasoning summary mode', () => {
    const result = materializeCodexSessionBundle(ctx, bundle());
    expect(result.argsAppend).not.toContain('model_reasoning_summary="auto"');
    expect(result.env.GUGU_CODEX_REASONING_SUMMARY).toBe('auto');
    expect(result.env.GUGU_CODEX_REASONING_SUMMARIES_SUPPORTED).toBe('true');
  });
});

describe('problem 9: gugu-delivered MCP servers are not asked about call by call', () => {
  it('the terminal leg approves every server in its thread config', () => {
    const result = materializeCodexSessionBundle(
      { ...ctx, surface: 'app-server' as const },
      bundle({
        mcpServers: [
          { name: 'gugu', url: 'http://127.0.0.1:1/mcp' },
          { name: 'quiet-probe-quiet', transport: 'stdio', command: '/usr/bin/node', args: ['server.mjs'], owner: 'integration' },
        ],
      }),
    );
    expect(result.threadConfig).toMatchObject({
      'mcp_servers.gugu.default_tools_approval_mode': 'approve',
      'mcp_servers.quiet_probe_quiet.default_tools_approval_mode': 'approve',
    });
  });
});

describe('#7191 a session with gugu\'s browser tab turns off codex\'s own browser plugins', () => {
  const browser = { name: 'gugu-browser', url: 'http://127.0.0.1:5/mcp', owner: 'integration' as const };
  const off = ['-c', 'plugins.browser@openai-bundled.enabled=false', '-c', 'plugins.chrome@openai-bundled.enabled=false'];

  it.each(['acp', 'app-server'] as const)('%s leg: both plugins off for this process only', (surface) => {
    const result = materializeCodexSessionBundle({ ...ctx, surface }, bundle({ mcpServers: [browser] }));
    expect(result.argsAppend.join(' ')).toContain(off.join(' '));
  });

  it('no browser tab in the session, codex\'s plugins stay as the person has them', () => {
    const result = materializeCodexSessionBundle(ctx, bundle({ mcpServers: [{ name: 'gugu', url: 'http://127.0.0.1:1/mcp' }] }));
    expect(result.argsAppend.join(' ')).not.toContain('openai-bundled');
  });
});

describe('Codex native tool surfaces preserve the catalog and explicit App disclosure', () => {
  const servers = [
    { name: 'gugu', url: 'http://127.0.0.1:1/mcp', alwaysLoad: true, owner: 'gugu' as const },
    { name: 'omnisearch', url: 'http://127.0.0.1:2/mcp', alwaysLoad: true, owner: 'integration' as const },
    { name: 'gw-probe-a', url: 'http://127.0.0.1:3/mcp', alwaysLoad: true, owner: 'integration' as const },
    { name: 'my-own', url: 'http://127.0.0.1:4/mcp', owner: 'user' as const },
  ];

  it('the terminal leg writes them into the app-server config by codex namespace', () => {
    const result = materializeCodexSessionBundle({ ...ctx, surface: 'app-server' as const }, bundle({ mcpServers: servers }));
    expect(result.threadConfig?.['features.code_mode.direct_only_tool_namespaces'])
      .toEqual(['mcp__omnisearch', 'mcp__gw_probe_a']);
    expect(result.threadConfig?.['mcp_servers.gugu.omit_tools_from']).toEqual(['deferred']);
    expect(result.threadConfig).not.toHaveProperty(['mcp_servers.my_own.omit_tools_from']);
    expect(result.threadConfig).not.toHaveProperty(['mcp_servers.omnisearch.omit_tools_from']);
  });

  it('the chat leg hands the same list to the ACP bridge', () => {
    const result = materializeCodexSessionBundle(ctx, bundle({ mcpServers: servers }));
    expect(JSON.parse(result.env.GUGU_CODEX_DIRECT_TOOL_NAMESPACES ?? 'null'))
      .toEqual(['mcp__omnisearch', 'mcp__gw_probe_a']);
  });

  it('a core-only session clears an inherited direct-only list on both legs', () => {
    const core = bundle({ mcpServers: [servers[0]!] });
    expect(materializeCodexSessionBundle({ ...ctx, surface: 'app-server' as const }, core).threadConfig?.['features.code_mode.direct_only_tool_namespaces'])
      .toEqual([]);
    expect(JSON.parse(materializeCodexSessionBundle(ctx, core).env.GUGU_CODEX_DIRECT_TOOL_NAMESPACES ?? 'null'))
      .toEqual([]);
  });

  it('nothing declared alwaysLoad, no list', () => {
    const own = bundle({ mcpServers: [servers[3]!] });
    expect(materializeCodexSessionBundle({ ...ctx, surface: 'app-server' as const }, own).threadConfig)
      .not.toHaveProperty(['features.code_mode.direct_only_tool_namespaces']);
    expect(materializeCodexSessionBundle(ctx, own).env).not.toHaveProperty('GUGU_CODEX_DIRECT_TOOL_NAMESPACES');
  });
});

describe('#6387 installed Apps\' skills: one skill root gugu owns, registered by codex as extra skill roots', () => {
  const skills = [
    { extensionId: 'choukatai', name: 'choukatai', description: 'Work a card table.', dir: '/apps/choukatai/skills/choukatai' },
    { extensionId: 'notes-app', name: 'notes', description: 'Keep notes.', dir: '/apps/notes-app/skills/notes' },
  ];

  it('links each skill as <extension>-<skill> in a root under GUGU_HOME, named by its content', () => {
    const result = materializeCodexSessionBundle(ctx, bundle({ extensionSkills: skills }));
    const root = JSON.parse(result.env.GUGU_CODEX_SKILL_ROOTS ?? 'null')?.[0] as string;
    expect(root).toMatch(/^\/gugu\/capability-packages\/codex\/skills\/[0-9a-f]{12}$/);
    expect(result.symlinks).toEqual([
      { sourcePath: '/apps/choukatai/skills/choukatai', path: `${root}/choukatai-choukatai`, optionalSource: false },
      { sourcePath: '/apps/notes-app/skills/notes', path: `${root}/notes-app-notes`, optionalSource: false },
    ]);
    // Another set is another folder: a skill taken away is not left in a root a new session reads.
    const fewer = materializeCodexSessionBundle(ctx, bundle({ extensionSkills: skills.slice(0, 1) }));
    expect(JSON.parse(fewer.env.GUGU_CODEX_SKILL_ROOTS ?? 'null')).not.toEqual([root]);
  });

  it('the chat leg hands the root to the ACP bridge; the terminal leg to its host, as skillRoots', () => {
    const chat = materializeCodexSessionBundle(ctx, bundle({ extensionSkills: skills }));
    expect(chat).not.toHaveProperty('skillRoots');
    const terminal = materializeCodexSessionBundle({ ...ctx, surface: 'app-server' as const }, bundle({ extensionSkills: skills }));
    expect(terminal.env).not.toHaveProperty('GUGU_CODEX_SKILL_ROOTS');
    expect(terminal.skillRoots).toEqual(JSON.parse(chat.env.GUGU_CODEX_SKILL_ROOTS ?? 'null'));
    expect(terminal.symlinks).toEqual(chat.symlinks);
  });

  it('a resumed session registers them again: the roots belong to the app-server process', () => {
    const resumed = materializeCodexSessionBundle({ ...ctx, lifecycle: 'resume' as const }, bundle({ extensionSkills: skills }));
    expect(resumed.env.GUGU_CODEX_SKILL_ROOTS).toBeDefined();
  });

  it('no skills, no root', () => {
    const result = materializeCodexSessionBundle(ctx, bundle());
    expect(result.env).not.toHaveProperty('GUGU_CODEX_SKILL_ROOTS');
    expect(result.symlinks).toEqual([]);
  });
});
