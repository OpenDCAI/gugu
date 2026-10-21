import { describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { OPENCODE_FAMILY_CONFIG_SPEC } from '../impl/opencode/session-bundle';
import { openCodeFamilyMcpConfig } from './opencode-family-session-config';

describe('openCodeFamilyMcpConfig — a local program', () => {
  // #6387 实机:照各家通用的 {transport, command, args, env} 写进去,opencode serve 对
  // POST /session 回 400,整条会话起不来。它要的是自己的方言(opencode.ai/docs/mcp-servers)。
  it('is written in opencode’s own shape, with env references it expands itself', () => {
    const bundle = {
      env: { GUGU_EXT_0_ELECTRON_RUN_AS_NODE: '1' },
      mcpServers: [
        {
          name: 'agent-notes',
          transport: 'stdio',
          command: '/Applications/咕咕.app/Contents/MacOS/咕咕',
          args: ['/launcher.mjs', '--', 'node', 'server.mjs'],
          env: { ELECTRON_RUN_AS_NODE: 'GUGU_EXT_0_ELECTRON_RUN_AS_NODE' },
          cwd: '/ext/agent-notes',
          owner: 'integration',
        },
      ],
    } as unknown as SessionCapabilityBundle;

    expect(openCodeFamilyMcpConfig(OPENCODE_FAMILY_CONFIG_SPEC, bundle)).toEqual({
      'agent-notes': {
        type: 'local',
        command: ['/Applications/咕咕.app/Contents/MacOS/咕咕', '/launcher.mjs', '--', 'node', 'server.mjs'],
        enabled: true,
        environment: { ELECTRON_RUN_AS_NODE: '{env:GUGU_EXT_0_ELECTRON_RUN_AS_NODE}' },
        cwd: '/ext/agent-notes',
      },
    });
  });
});
