import type { CommandContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { provider as auggie } from './auggie';
import { provider as commandcode } from './commandcode';
import { provider as droid } from './droid';
import { provider as qoder } from './qoder';
import { provider as qwen } from './qwen';

const baseContext: CommandContext = {
  cli: '',
  permissionMode: 'edit',
  initialPrompt: undefined,
  cliSessionId: 'emdash-session-id',
  providerSessionId: undefined,
  isResuming: false,
  model: '',
};

const storedSessionCases = [
  {
    name: 'auggie',
    buildCommand: (ctx: CommandContext) => auggie.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'auggie', providerSessionId: 'auggie-session-id', isResuming: true },
    expected: {
      command: 'auggie',
      args: ['--allow-indexing', '--resume', 'auggie-session-id'],
      env: {},
    },
  },
  {
    name: 'commandcode',
    buildCommand: (ctx: CommandContext) => commandcode.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'command-code', providerSessionId: 'command-session-id', isResuming: true },
    expected: {
      command: 'command-code',
      args: ['--trust', '--skip-onboarding', '--resume', 'command-session-id'],
      env: {},
    },
  },
  {
    name: 'droid',
    buildCommand: (ctx: CommandContext) => droid.behavior.prompt!.buildCommand(ctx),
    context: {
      cli: 'droid',
      providerSessionId: '31477a03-961a-4451-82d4-efded56947fc',
      isResuming: true,
    },
    expected: {
      command: 'droid',
      args: ['--resume', '31477a03-961a-4451-82d4-efded56947fc'],
      env: {},
    },
  },
  {
    name: 'qoder',
    buildCommand: (ctx: CommandContext) => qoder.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'qodercli', providerSessionId: 'qoder-session-id', isResuming: true },
    expected: {
      command: 'qodercli',
      args: ['-r', 'qoder-session-id'],
      env: {},
    },
  },
  {
    name: 'qwen',
    buildCommand: (ctx: CommandContext) => qwen.behavior.prompt!.buildCommand(ctx),
    context: {
      cli: 'qwen',
      providerSessionId: '31477a03-961a-4451-82d4-efded56947fc',
      isResuming: true,
    },
    expected: {
      command: 'qwen',
      args: ['--resume', '31477a03-961a-4451-82d4-efded56947fc'],
      env: {},
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  buildCommand: (ctx: CommandContext) => unknown;
  context: Partial<CommandContext>;
  expected: unknown;
}>;

const fallbackCases = [
  {
    name: 'auggie',
    buildCommand: (ctx: CommandContext) => auggie.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'auggie', isResuming: true },
    expected: { command: 'auggie', args: ['--allow-indexing', '--continue'], env: {} },
  },
  {
    name: 'qoder',
    buildCommand: (ctx: CommandContext) => qoder.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'qodercli', isResuming: true },
    expected: { command: 'qodercli', args: ['-c'], env: {} },
  },
  {
    name: 'qwen',
    buildCommand: (ctx: CommandContext) => qwen.behavior.prompt!.buildCommand(ctx),
    context: { cli: 'qwen', isResuming: true },
    expected: { command: 'qwen', args: ['--continue'], env: {} },
  },
] satisfies ReadonlyArray<{
  name: string;
  buildCommand: (ctx: CommandContext) => unknown;
  context: Partial<CommandContext>;
  expected: unknown;
}>;

describe('provider prompt session resume contracts', () => {
  it.each(storedSessionCases)('$name resumes its stored provider session id', (testCase) => {
    expect(testCase.buildCommand({ ...baseContext, ...testCase.context })).toEqual(
      testCase.expected,
    );
  });

  it.each(fallbackCases)('$name uses its verified resume fallback without a provider id', (testCase) => {
    expect(testCase.buildCommand({ ...baseContext, ...testCase.context })).toEqual(
      testCase.expected,
    );
  });
});
