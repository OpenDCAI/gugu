import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import {
  opencodeFamilyModelCredential,
  statusFromAuthListOutput,
} from './opencode-family-credential';

/** 以「home 相对路径 → 文件内容」的静态表造一把 fs;表里没有 = 文件不存在(read 回 null)。 */
function ctx(input: {
  files?: Record<string, string>;
  env?: Record<string, string>;
  fsFollowsConfigRoot?: boolean;
  readError?: boolean;
}): AgentAuthContext {
  return {
    cli: 'opencode',
    env: input.env ?? {},
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => {
        if (input.readError) throw new Error('EACCES');
        return input.files?.[path] ?? null;
      }),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
    ...(input.fsFollowsConfigRoot !== undefined
      ? { fsFollowsConfigRoot: input.fsFollowsConfigRoot }
      : {}),
  };
}

const judge = opencodeFamilyModelCredential({
  dataDirName: 'opencode',
  configFileBase: 'opencode',
  homeEnvVar: 'OPENCODE_TEST_HOME',
});

// 引擎自缓存的 models.dev 快照(实测形状:顶层 provider id → { env: [...] })。
const MODELS_JSON = JSON.stringify({
  opencode: { env: ['OPENCODE_API_KEY'] },
  openai: { env: ['OPENAI_API_KEY'] },
});

describe('opencodeFamilyModelCredential', () => {
  it('reports credentialed when auth.json holds the model provider', async () => {
    await expect(
      judge(
        ctx({
          files: {
            '.local/share/opencode/auth.json': JSON.stringify({ opencode: { type: 'api' } }),
          },
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('credentialed');
  });

  it('reports uncredentialed when the provider is in none of the three sources', async () => {
    // #4956 的本机形状:auth.json 有别家凭据(openai/openrouter),默认模型的 provider 却没有。
    await expect(
      judge(
        ctx({
          files: {
            '.local/share/opencode/auth.json': JSON.stringify({ openai: {}, openrouter: {} }),
            '.cache/opencode/models.json': MODELS_JSON,
          },
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('uncredentialed');
  });

  it('reports uncredentialed on a machine with no auth.json at all', async () => {
    // 文件不存在是真读数(从没登过任何 provider),不是仪器失败 —— mimo 的本机形状。
    await expect(
      judge(
        ctx({ files: { '.cache/opencode/models.json': JSON.stringify({ xiaomi: { env: [] } }) } }),
        'xiaomi/mimo-v2.5-pro-ultraspeed'
      )
    ).resolves.toBe('uncredentialed');
  });

  it('reports credentialed when a provider env var from the engine snapshot is set', async () => {
    await expect(
      judge(
        ctx({
          files: { '.cache/opencode/models.json': MODELS_JSON },
          env: { OPENAI_API_KEY: 'k' },
        }),
        'openai/gpt-5.6'
      )
    ).resolves.toBe('credentialed');
  });

  it('reports unknown when the engine snapshot is unavailable', async () => {
    // env 轴没查成 ⇒ 判据未验证 —— ❌ 不拿失败的仪器出阴性读数。
    await expect(judge(ctx({}), 'opencode/big-pickle')).resolves.toBe('unknown');
  });

  it('reports unknown when auth.json cannot be parsed', async () => {
    await expect(
      judge(
        ctx({
          files: { '.local/share/opencode/auth.json': '{corrupt' },
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('unknown');
  });

  it('reports unknown when fs reads fail outright', async () => {
    await expect(judge(ctx({ readError: true }), 'opencode/big-pickle')).resolves.toBe('unknown');
  });

  it('reports unknown when the global config declares the provider', async () => {
    await expect(
      judge(
        ctx({
          files: {
            '.cache/opencode/models.json': MODELS_JSON,
            '.config/opencode/opencode.json': JSON.stringify({
              provider: { opencode: { options: { apiKey: 'inline' } } },
            }),
          },
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('unknown');
  });

  it('reports unknown for a model id without a provider prefix', async () => {
    await expect(judge(ctx({}), 'big-pickle')).resolves.toBe('unknown');
  });

  it('does not read inherited object keys as stored credentials', async () => {
    // `in` 走原型链:provider 恰好叫 `constructor` 时,空 auth.json 会被误判成有凭据 ——
    // 兜底被压掉,首句照死。判据必须是 Object.hasOwn。
    await expect(
      judge(
        ctx({
          files: {
            '.local/share/opencode/auth.json': JSON.stringify({}),
            '.cache/opencode/models.json': JSON.stringify({ constructor: { env: [] } }),
          },
        }),
        'constructor/some-model'
      )
    ).resolves.toBe('uncredentialed');
  });

  it('reports unknown when the data root was relocated away from this fs', async () => {
    await expect(
      judge(
        ctx({
          files: { '.cache/opencode/models.json': MODELS_JSON },
          env: { OPENCODE_TEST_HOME: '/elsewhere' },
          fsFollowsConfigRoot: false,
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('unknown');
  });

  it('judges normally when the relocation came from the managed shadow home', async () => {
    await expect(
      judge(
        ctx({
          files: { '.cache/opencode/models.json': MODELS_JSON },
          env: { OPENCODE_TEST_HOME: '/shadow' },
          fsFollowsConfigRoot: true,
        }),
        'opencode/big-pickle'
      )
    ).resolves.toBe('uncredentialed');
  });
});

describe('statusFromAuthListOutput', () => {
  it('parses the shared opencode-family credential count line', () => {
    expect(statusFromAuthListOutput('┌ Credentials …\n└ 0 credentials')).toEqual({
      kind: 'unauthenticated',
    });
    expect(statusFromAuthListOutput('└ 2 credentials')).toEqual({ kind: 'authenticated' });
    expect(statusFromAuthListOutput('unrelated output')).toEqual({ kind: 'unknown' });
  });
});
