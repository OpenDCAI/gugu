import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as engineTree from '@gugu/session-core/acp/node'
import { awaitFact, awaitPending } from '../../../support/awaitFact'
// 包一层,不替换:spawn 仍是真的(见下面 fakeAgent 的说明),只是让「慢但一直在推进」那条拿得到子进程的输出流。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const {
  FAILURE_TTL_MS,
  __drainProbesForTest,
  __resetHarnessModelCatalogCache,
  __setInactivityLimitForTest,
  getHarnessModelCatalog,
  lookupHarnessModelCatalog,
  probeHarnessModelCatalog,
  setAcpSpawnResolver,
  setCatalogKeyResolver,
  setCatalogStore,
  setProbePlatformEnvResolver,
  setSpawnIdentityResolver,
} = await import(
  '../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog'
)
/**
 * 一个会说 ACP 的假 agent。
 *
 * ❌ 不 mock 掉子进程：本模块的价值恰恰在「起进程 + 说协议 + 解析回包」这条链上，把进程 mock 掉
 * 等于把被测的东西换成了桩。这里起的是真进程、走的是真 stdio、发的是真 JSON-RPC —— 只有对面
 * 那个 agent 是可控的。
 */
async function fakeAgent(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-fake-acp-'))
  const file = join(dir, 'agent.mjs')
  await writeFile(
    file,
    `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    handle(msg);
  }
});
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const fail = (id, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\\n');
${body}
`,
    'utf8',
  )
  return file
}
const SESSION_WITH_MODELS = `
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, {
    sessionId: 'sess-1',
    configOptions: [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }] },
      { id: 'model', category: 'model', type: 'select', currentValue: 'opus[1m]', options: [
        { value: 'default', name: 'Default (recommended)', description: 'Opus 5 with 1M context' },
        { value: 'opus[1m]', name: 'Opus (1M context)', description: 'Opus 5 with 1M context' },
        { value: 'haiku', name: 'Haiku' },
      ] },
    ],
  });
}
`
async function useAgent(body: string): Promise<void> {
  const entry = await fakeAgent(body)
  setAcpSpawnResolver(async () => ({ command: process.execPath, args: [entry], env: {} }))
}
beforeEach(() => {
  setAcpSpawnResolver(async () => null)
  setProbePlatformEnvResolver(async () => ({ env: {} }))
})
describe('ACP 模型目录探测', () => {
  it.each(['target-low', 'target-none', 'ignored'])('reads the requested native model axis, refusing an unconfirmed switch (%s)', async (target) => {
    await useAgent(`
const options = (model, levels) => [
  { configId: 'native-model', category: 'model', type: 'select', currentValue: model, options: ['default', 'target-low', 'target-none', 'ignored'].map(value => ({ value, name: value })) },
  ...(levels.length ? [{ id: 'depth', category: 'thought_level', type: 'select', currentValue: levels[0], options: levels.map(value => ({ value, name: value })) }] : []),
];
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 'probe', configOptions: options('default', ['high']) });
  if (msg.method === 'session/set_config_option') {
    if (msg.params.sessionId !== 'probe' || msg.params.configId !== 'native-model') return fail(msg.id, { code: -32602, message: 'wrong session or native axis' });
    const model = msg.params.value;
    return reply(msg.id, { configOptions: model === 'ignored' ? options('default', ['high']) : options(model, model === 'target-low' ? ['low'] : []) });
  }
}
`)
    const state = await probeHarnessModelCatalog('codex', 'acp', target)
    if (target === 'ignored') {
      expect(state).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('did not confirm') })
    } else {
      expect(state).toMatchObject({ kind: 'ready', selected: target, efforts: target === 'target-low' ? [{ id: 'low', name: 'low' }] : [] })
    }
  })
  it('清理失败进入 unavailable，不发布 ready 或误报 harness 未安装', async () => {
    await useAgent(SESSION_WITH_MODELS)
    const stop = engineTree.signalEngineTree
    const spy = vi.spyOn(engineTree, 'signalEngineTree').mockImplementationOnce((...args) => {
      stop(...args)
      throw Object.assign(new Error('cleanup command missing'), { code: 'ENOENT' })
    })
    try {
      const state = await probeHarnessModelCatalog('opencode', 'acp')
      expect(state).toEqual({ kind: 'unavailable', reason: 'ACP model probe cleanup failed: cleanup command missing' })
    } finally {
      spy.mockRestore()
    }
  })
  it.runIf(process.platform === 'win32')('通过真实 .cmd 入口读取 ACP 模型目录', async () => {
    const entry = await fakeAgent(SESSION_WITH_MODELS)
    const shim = `${entry}.cmd`
    const pidFile = `${entry}.pid`
    await writeFile(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${await readFile(entry, 'utf8')}`)
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
    setAcpSpawnResolver(async () => ({ command: shim, args: ['acp'], env: {} }))
    const state = await probeHarnessModelCatalog('opencode', 'acp')
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.models.map((model) => model.id)).toEqual(['default', 'opus[1m]', 'haiku'])
    const pid = Number(await readFile(pidFile, 'utf8'))
    // 探测收摊后 .cmd 背后的 node 进程必须消失:等「它从进程表里没了」这个事实,❌ 1s 的轮询上限。
    await awaitFact(`探测进程 ${pid} 退出`, () => {
      try { process.kill(pid, 0); return undefined } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
        throw error
      }
    })
  })
  it('探针那一条 session/new 带上插件给的 _meta(不装用户 MCP);没给就不带', async () => {
    const seenFile = join(await mkdtemp(join(tmpdir(), 'gugu-probe-meta-')), 'params.jsonl')
    const entry = await fakeAgent(`
import { appendFileSync } from 'node:fs';
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'session/new') {
    appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify(msg.params) + '\\n');
    return reply(msg.id, { sessionId: 's', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] },
    ] });
  }
}
`)
    const meta = { claudeCode: { options: { strictMcpConfig: true } } }
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [entry], env: {}, sessionMeta: meta }))
    expect((await probeHarnessModelCatalog('claude', 'acp')).kind).toBe('ready')
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [entry], env: {} }))
    expect((await probeHarnessModelCatalog('opencode', 'acp')).kind).toBe('ready')
    const seen = (await readFile(seenFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ mcpServers: [], _meta: meta })
    expect(seen[1]).not.toHaveProperty('_meta')
  })
  it('从 session/new 的 configOptions[category=model] 读出清单与当前选中', async () => {
    await useAgent(SESSION_WITH_MODELS)
    const state = await probeHarnessModelCatalog('claude', 'acp')
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.models.map((m) => m.id)).toEqual(['default', 'opus[1m]', 'haiku'])
    expect(state.models[0]?.name).toBe('Default (recommended)')
    expect(state.models[0]?.description).toBe('Opus 5 with 1M context')
    expect(state.models[2]).not.toHaveProperty('description')
    expect(state.selected).toBe('opus[1m]')
  })
  it('从 models.availableModels 读出 ACP 清单并保留当前模型', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, {
    sessionId: 'sess-hermes',
    models: {
      currentModelId: 'openai-api:gpt-5.6',
      availableModels: [
        { modelId: 'openai-api:gpt-5.6', name: 'GPT 5.6', description: 'OpenAI' },
        { modelId: 'anthropic:claude-sonnet-5', name: 'Claude Sonnet 5' },
      ],
    },
    modes: { availableModes: [{ id: 'default', name: 'Default' }] },
  });
}
`)
    const state = await probeHarnessModelCatalog('hermes', 'acp')
    if (state.kind !== 'ready') throw new Error(`期望 ready，实得 ${state.kind}`)
    expect(state.models.map((model) => model.id)).toEqual(['openai-api:gpt-5.6', 'anthropic:claude-sonnet-5'])
    expect(state.models[0]).toEqual({ id: 'openai-api:gpt-5.6', name: 'GPT 5.6', description: 'OpenAI' })
    expect(state.selected).toBe('openai-api:gpt-5.6')
  })
  it('两种 ACP 清单同时存在时按 id 去重而不吞另一来源', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, {
    configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'shared', name: 'Config shared' }] }],
    models: { availableModels: [{ modelId: 'shared', name: 'Reported shared' }, { modelId: 'extra', name: 'Reported extra' }] },
  });
}
`)
    const state = await probeHarnessModelCatalog('cursor', 'acp')
    if (state.kind !== 'ready') throw new Error(`期望 ready，实得 ${state.kind}`)
    expect(state.models.map((model) => model.id)).toEqual(['shared', 'extra'])
  })
  it('只认 category=model 那一项，不把 mode / thought_level 当模型', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's', configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }] },
    { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
    { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5.6-sol', options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }] },
  ] });
}
`)
    const state = await probeHarnessModelCatalog('codex', 'acp')
    if (state.kind !== 'ready') throw new Error(`期望 ready，实得 ${state.kind}`)
    expect(state.models.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
  })
  it('未登录 → auth-required，并把协议回的登录方式带出来', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, {
    code: -32000,
    message: 'Authentication required: Use Qwen Code CLI to authenticate first.',
    data: {
      authMethods: [
        {
          id: 'openai',
          name: 'Use OpenAI API key',
          description: 'Requires setting the \`OPENAI_API_KEY\` environment variable',
          _meta: { type: 'terminal', args: ['--auth-type=openai'] },
        },
      ],
    },
  });
}
`)
    const state = await probeHarnessModelCatalog('qwen', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([
      {
        id: 'openai',
        name: 'Use OpenAI API key',
        description: 'Requires setting the `OPENAI_API_KEY` environment variable',
        kind: 'terminal',
        terminal: { style: 'append', args: ['--auth-type=openai'] },
      },
    ])
  })
  it('只对 Claude 解释 auth-status=none，其他 harness 保留模型目录', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_auth/status_update', params: { authStatus: { kind: 'none' } } }) + '\\n');
    return reply(msg.id, { protocolVersion: 1 });
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's', configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'native-codex', options: [{ value: 'native-codex', name: 'Native Codex' }] },
  ] });
}
`)
    const claudeState = await probeHarnessModelCatalog('claude', 'acp')
    expect(claudeState.kind).toBe('auth-required')
    const state = await probeHarnessModelCatalog('codex', 'acp')
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.models.map((model) => model.id)).toEqual(['native-codex'])
  })
  /**
   * 「有没有登录方式」这个读数,一半是咕咕自己发出去的。
   *
   * 线上有**两套互不相认的门控**,各管一批 harness:
   *  · 规范的 `clientCapabilities.auth.terminal` —— 新一代 adapter 认它
   *    (咕咕钉的 `@agentclientprotocol/*` 就是这一代);
   *  · Zed 的厂商扩展 `clientCapabilities._meta['terminal-auth']` —— 老一代认它
   *    (opencode / mimocode / 老 `@zed-industries/claude-code-acp`)。
   *
   * 下面那个假 agent 的判断逐字照抄 opencode 的真门控:`sst/opencode@c2eacd7`
   * `packages/opencode/src/acp/service.ts:102-111` 的
   * `if (params.clientCapabilities?._meta?.["terminal-auth"] === true)`。
   *
   * ⇒ 这条用例是**行为级**的:少发任何一个标志,对应那条方法就整条消失,数组当场对不上。
   *    ❌ 别把它改写成「断言 initialize 的 payload 里有这两个字段」—— 那种写法在 agent
   *    根本不看这些字段时也会绿。
   */
  it('两道门各管一批 harness —— 规范能力与 Zed 的 _meta 方言,缺一个就有一批登录方式消失', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    const caps = (msg.params && msg.params.clientCapabilities) || {};
    globalThis.__gates = {
      spec: !!(caps.auth && caps.auth.terminal === true),
      zed: !!(caps._meta && caps._meta['terminal-auth'] === true),
    };
    return reply(msg.id, { protocolVersion: 1 });
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') {
    const g = globalThis.__gates || {};
    const methods = [];
    if (g.spec) methods.push({
      id: 'spec-gated',
      name: 'Sign in',
      type: 'terminal',
      args: ['--cli', 'auth', 'login', '--claudeai'],
    });
    if (g.zed) methods.push({
      id: 'zed-gated',
      name: 'Login with opencode',
      _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'], label: 'OpenCode Login' } },
    });
    return fail(msg.id, { code: -32000, message: 'Authentication required', data: { authMethods: methods } });
  }
}
`)
    const state = await probeHarnessModelCatalog('opencode', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([
      {
        id: 'spec-gated',
        name: 'Sign in',
        kind: 'terminal',
        terminal: { style: 'append', args: ['--cli', 'auth', 'login', '--claudeai'] },
      },
      {
        id: 'zed-gated',
        name: 'Login with opencode',
        kind: 'terminal',
        terminal: { style: 'command', command: 'opencode', args: ['auth', 'login'] },
      },
    ])
  })
  /**
   * terminal-auth 方言 —— 给的是**一条完整命令行**,不是要追加的参数。
   * 出处:@github/copilot 1.0.80 的 app.js 偏移 5625022,{command, args, label} 由
   * process.argv[0] 与 [...(argv[1] 若像脚本), 'login'] 现算;
   * @qoder-ai/qodercli 1.1.31 与 MoonshotAI/kimi-code@b17bd61 也发同一个键。
   *
   * ⚠️ 它与 qwen 那条**必须**归一成不同的 style:一个追加、一个替换。
   *    合并成同一个 args 数组就会拼出一条谁也没说过的命令。
   */
  it('把 terminal-auth 方言认成一条完整命令行,而不是要追加的参数', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, {
    protocolVersion: 1,
    authMethods: [{
      id: 'copilot-login',
      name: 'Log in with Copilot CLI',
      _meta: { 'terminal-auth': { command: '/usr/bin/copilot', args: ['login'], label: 'Copilot Login' } },
    }],
  });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32000, message: 'Authentication required' });
}
`)
    const state = await probeHarnessModelCatalog('copilot', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([
      {
        id: 'copilot-login',
        name: 'Log in with Copilot CLI',
        kind: 'terminal',
        terminal: { style: 'command', command: '/usr/bin/copilot', args: ['login'] },
      },
    ])
  })
  /**
   * 规范那一种 —— type: "terminal" + 顶层 args。
   * 实测出处:@agentclientprotocol/claude-agent-acp 0.54.1,d15 真起进程差分(见本次报告)。
   * ⚠️ args 是给 **adapter** 的(--cli 只有 adapter 认),不是给 claude 那个 CLI 的。
   */
  it('把规范的 type:terminal 认成「追加到 agent 程序后面的参数」', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, {
    protocolVersion: 1,
    authMethods: [{
      id: 'claude-ai-login',
      name: 'Claude Subscription',
      type: 'terminal',
      args: ['--cli', 'auth', 'login', '--claudeai'],
    }],
  });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32000, message: 'Authentication required' });
}
`)
    const state = await probeHarnessModelCatalog('claude', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([
      {
        id: 'claude-ai-login',
        name: 'Claude Subscription',
        kind: 'terminal',
        terminal: { style: 'append', args: ['--cli', 'auth', 'login', '--claudeai'] },
      },
    ])
  })
  /**
   * 认不出的 type 一律 unknown,❌ 不当成 agent。
   * 规范允许自定义类型;当成 agent 就会对着一个没读懂的方法发一个协议可能禁止的请求。
   */
  it('认不出的 type 记 unknown —— 说得出名字,但不给动作', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, {
    protocolVersion: 1,
    authMethods: [{ id: 'x', name: 'Something new', type: '_vendorSpecific' }],
  });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32000, message: 'Authentication required' });
}
`)
    const state = await probeHarnessModelCatalog('kimi', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([{ id: 'x', name: 'Something new', kind: 'unknown' }])
  })
  /**
   * kimi 0.38.0 实测(2026-08-26,MBP 验收实例):它的 `session/new` 只回一个**裸的** `-32000`,
   * `data` 里没有 authMethods —— 登录方式在更早的 `initialize` 响应里
   * (ACP `InitializeResponse.authMethods`)。
   *
   * 少了这一条的后果:kimi 被判成 `unavailable`,界面说「读取 Kimi 的模型失败」——
   * 告诉用户「坏了」,而真相是「去登录就行」;并且 `auth-required` 专属的第二遍探测不会跑,
   * 推理强度那一行跟着一起消失。⇒ 这条断言在改动前必红。
   */
  it('只回裸 -32000(登录方式在 initialize 里)→ 仍是 auth-required', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, {
    protocolVersion: 1,
    authMethods: [{ id: 'moonshot', name: 'Sign in to Moonshot' }],
  });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32000, message: 'Authentication required' });
}
`)
    const state = await probeHarnessModelCatalog('kimi', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([
      { id: 'moonshot', name: 'Sign in to Moonshot', kind: 'agent' },
    ])
  })
  it('裸 -32000 且 initialize 也没给方式 → 还是 auth-required,只是说不出去哪登', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32000, message: 'Authentication required' });
}
`)
    const state = await probeHarnessModelCatalog('kimi', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.authMethods).toEqual([])
  })
  it('起不来 → not-installed（而不是笼统的失败）', async () => {
    setAcpSpawnResolver(async () => ({ command: '/nonexistent/agent-binary', args: [], env: {} }))
    expect((await probeHarnessModelCatalog('ghost', 'acp')).kind).toBe('not-installed')
  })
  it('没有这个插件 → not-installed', async () => {
    setAcpSpawnResolver(async () => 'not-found')
    expect((await probeHarnessModelCatalog('ghost', 'acp')).kind).toBe('not-installed')
  })
  it('插件在、但压根不说 ACP → unsupported（❌ 不是 not-installed）', async () => {
    setAcpSpawnResolver(async () => null)
    expect((await probeHarnessModelCatalog('amp', 'acp')).kind).toBe('unsupported')
  })
  it('非认证类的 RPC 失败 → unavailable，带原因', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32603, message: 'internal boom' });
}
`)
    const state = await probeHarnessModelCatalog('broken', 'acp')
    expect(state.kind).toBe('unavailable')
    if (state.kind !== 'unavailable') return
    expect(state.reason).toContain('internal boom')
  })
  it('Python SDK 的 -32603 把原因放在 data.details → unavailable 的原因是那句话,不是 Internal error', async () => {
    // hermes 0.21.5 没配 provider 时 session/new 的逐字形状(2026-09-28 mac1)。
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32603, message: 'Internal error', data: { details: 'Hermes is not connected to any AI provider yet. Run hermes model to pick one.' } });
}
`)
    const state = await probeHarnessModelCatalog('hermes', 'acp')
    expect(state.kind).toBe('unavailable')
    if (state.kind !== 'unavailable') return
    expect(state.reason).toBe(
      'Hermes is not connected to any AI provider yet. Run hermes model to pick one.\ncode=-32603',
    )
  })
  it('说了 ACP 但没有模型选择这回事 → ready 但清单为空', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's', configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [] },
  ] });
}
`)
    const state = await probeHarnessModelCatalog('amp', 'acp')
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.models).toEqual([])
  })
  it('对 adapter 的反请求一律拒绝 —— 探针不产生任何副作用', async () => {
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'fs/write_text_file', params: { path: '/tmp/should-not-happen' } }) + '\\n');
    return reply(msg.id, { protocolVersion: 1 });
  }
  if (msg.method === 'initialized') return;
  if (msg.id === 999) { globalThis.__answer = msg.error ? 'rejected' : 'accepted'; return; }
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's', configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [
      { value: 'm', name: 'M', description: String(globalThis.__answer) },
    ] },
  ] });
}
`)
    const state = await probeHarnessModelCatalog('nosy', 'acp')
    if (state.kind !== 'ready') throw new Error(`期望 ready，实得 ${state.kind}`)
    expect(state.models[0]?.description).toBe('rejected')
  })
})
describe('模型目录缓存', () => {
  /** 记下探了几次 —— 缓存有没有生效，只能靠「真去起进程的次数」来判。 */
  let probes = 0
  async function agentThatCounts(): Promise<void> {
    const entry = await fakeAgent(SESSION_WITH_MODELS)
    setAcpSpawnResolver(async () => {
      probes += 1
      return { command: process.execPath, args: [entry], env: {} }
    })
  }
  /** 内存版 store：只验作废逻辑，不验 drizzle。 */
  function memoryStore() {
    let saved: Record<string, unknown> = {}
    return {
      read: async () => saved as never,
      write: async (all: Record<string, unknown>) => {
        saved = all
      },
      get raw() {
        return saved
      },
    }
  }
  beforeEach(() => {
    probes = 0
    __resetHarnessModelCatalogCache()
    setCatalogStore(null)
    // 身份解析器是模块级的:不重置会漏给后面的用例,让它们在一个别人设好的身份下跑。
    setSpawnIdentityResolver(async () => null)
  })
  afterEach(() => {
    setSpawnIdentityResolver(async () => null)
  })
  it('第二次直接吃缓存，不再起进程', async () => {
    await agentThatCounts()
    const first = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.229' })
    const second = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.229' })
    expect(first.kind).toBe('ready')
    expect(second).toEqual(first)
    expect(probes).toBe(1)
  })
  it('harness 版本一变就作废 —— 这是主闸', async () => {
    await agentThatCounts()
    await getHarnessModelCatalog('codex', { leg: 'acp',  harnessVersion: '0.144.6' })
    await getHarnessModelCatalog('codex', { leg: 'acp',  harnessVersion: '0.146.0' })
    expect(probes).toBe(2)
  })
  /**
   * #5605:双账号。`claude2` 这类 `CLAUDE_CONFIG_DIR` wrapper 与裸 `claude` 指向同一个二进制,
   * **版本号逐字相同**,换的只是读哪个配置根(= 哪个账号)。
   *
   * ⚠️ 这条在改动前**必红**(实测 probes=1):版本闸是身份的有损投影,看不见账号。用户在设置里
   * 换完那一份,界面继续显示换之前那次探测的结论,只有重启 app 才生效。
   */
  it('换了跑哪一份(版本没变)就作废 —— 换账号/换拷贝必须立刻生效', async () => {
    await agentThatCounts()
    let identity = '/root/.local/bin/claude'
    setSpawnIdentityResolver(async () => identity)
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.270' })
    identity = '/root/.local/bin/claude2'
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.270' })
    expect(probes).toBe(2)
  })
  it('身份与版本都没变 → 照旧吃缓存（指纹不能把缓存变成摆设）', async () => {
    await agentThatCounts()
    setSpawnIdentityResolver(async () => '/root/.local/bin/claude2')
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.270' })
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.270' })
    expect(probes).toBe(1)
  })
  /** 身份拿不到(没装/运行时不兼容)时必须**退化**成旧的版本闸,❌ 不能因此把目录判成坏的。 */
  it('身份算不出来 → 退回版本闸', async () => {
    await agentThatCounts()
    setSpawnIdentityResolver(async () => null)
    expect((await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })).kind).toBe('ready')
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(probes).toBe(1)
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2' })
    expect(probes).toBe(2)
  })
  /**
   * 失败态是「用户此刻还没登录 / 还没装」这个**瞬时事实**,❌ 不该跨重启存活 —— #5605 里那句
   * `auth-required` 在 appSettings 上躺了 17 分钟,而用户早就换好了。
   * `FAILURE_TTL_MS` 的职责只是把连点几下合并掉(并发去重由 `inFlight` 负责),它只该活在内存里。
   */
  it('失败态不落盘 —— 盘上只留成功的读数', async () => {
    const disk = memoryStore()
    setCatalogStore(disk)
    setAcpSpawnResolver(async () => ({
      command: join(tmpdir(), 'gugu-this-binary-does-not-exist'),
      args: [],
      env: {},
    }))
    const state = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(state.kind).toBe('not-installed')
    expect(Object.keys(disk.raw)).toEqual([])
  })
  it('force 立刻重探 —— 用户刚装完/刚登录完不该等 TTL', async () => {
    await agentThatCounts()
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1', force: true })
    expect(probes).toBe(2)
  })
  it('失败态很快就重探，成功态照旧吃缓存', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      setAcpSpawnResolver(async () => {
        attempts += 1
        return 'not-found' // 没有这个插件 = not-installed
      })
      expect((await getHarnessModelCatalog('ghost', { leg: 'acp',  harnessVersion: '1' })).kind)
        .toBe('not-installed')
      expect(attempts).toBe(1)
      vi.setSystemTime(Date.now() + FAILURE_TTL_MS + 1_000)
      await getHarnessModelCatalog('ghost', { leg: 'acp',  harnessVersion: '1' })
      expect(attempts).toBe(2)
      __resetHarnessModelCatalogCache()
      await agentThatCounts()
      await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
      expect(probes).toBe(1)
      vi.setSystemTime(Date.now() + FAILURE_TTL_MS + 1_000)
      await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
      expect(probes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('并发调用只起一个进程', async () => {
    await agentThatCounts()
    const [a, b, c] = await Promise.all([
      getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' }),
      getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' }),
      getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' }),
    ])
    expect(probes).toBe(1)
    expect(a.kind).toBe('ready')
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })
  it('落盘后换一个「进程」也不用重探', async () => {
    const disk = memoryStore()
    setCatalogStore(disk)
    await agentThatCounts()
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.229' })
    expect(probes).toBe(1)
    __resetHarnessModelCatalogCache() // = 重启，内存没了，盘还在
    const afterRestart = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2.1.229' })
    expect(afterRestart.kind).toBe('ready')
    expect(probes).toBe(1)
  })
  it('落盘失败不影响这次结果', async () => {
    setCatalogStore({
      read: async () => ({}),
      write: async () => {
        throw new Error('disk full')
      },
    })
    await agentThatCounts()
    const state = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(state.kind).toBe('ready')
  })
})
/**
 * 第二趟(占位凭据补探档位)——**改动前这条路一条断言都没有**。
 *
 * 这一卷盯的是「一趟握手 = 一次 harness 冷启」这个代价:2026-08-26 d15 实测,
 * `mimo --version` 光把 99MB bundle 启起来打一行版本号就要 3.8s,它的 ACP
 * `initialize` 4.6s / `session/new` 0.8s。第二趟白跑一次,用户就白等一整份。
 */
describe('第二趟:占位凭据补探档位', () => {
  /** 起了几次进程 —— 「第二趟跑没跑」只能靠这个数判。 */
  let spawns = 0
  /**
   * 一个**按凭据分岔**的假 agent:
   *  · 没有 `GUGU_PROBE_MARK` → 回 -32000(未登录),就是第一趟会看到的;
   *  · 有 → 回一份带 `thought_level` 的 session,就是第二趟该拿到的增量。
   *
   * ⚠️ 分岔判据必须是**进程真正收到的环境变量**,不是解析器的入参:被测的正是
   * 「那份凭据有没有落到 spawn 的 env 上」。读入参等于让仪器自己给自己打分。
   */
  async function useForkingAgent(): Promise<void> {
    const entry = await fakeAgent(`
const marked = process.env.GUGU_PROBE_MARK === 'yes';
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, {
    protocolVersion: 1,
    authMethods: [{ id: 'moonshot', name: 'Sign in to Moonshot' }],
  });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') {
    if (!marked) return fail(msg.id, { code: -32000, message: 'Authentication required' });
    return reply(msg.id, { sessionId: 's', configOptions: [
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ] },
      { id: 'model', category: 'model', type: 'select', currentValue: 'probe-only', options: [
        { value: 'probe-only', name: 'Probe only' },
      ] },
    ] });
  }
}
`)
    setAcpSpawnResolver(async () => {
      spawns += 1
      return { command: process.execPath, args: [entry], env: {} }
    })
  }
  beforeEach(() => {
    spawns = 0
    setProbePlatformEnvResolver(async () => ({ env: {} }))
  })
  /**
   * 生成不出占位凭据(这家没有 Chat UI 契约、契约未接通、分派不出信封)⇒ 抛,写明哪一家、为什么。
   * ❌ 当成「没有凭据」悄悄跳过 —— 第二趟从接上那天起就因为这个从来没跑过(#4069 → 10-17)。
   */
  it('生成不出占位凭据 → 抛,❌ 悄悄退回未登录结论', async () => {
    await useForkingAgent()
    setProbePlatformEnvResolver(async (pluginId) => {
      throw new Error(`model catalog probe: ${pluginId} placeholder credentials unavailable — not wired`)
    })
    await expect(probeHarnessModelCatalog('qoder', 'acp')).rejects.toThrow(/qoder placeholder credentials unavailable/)
    expect(spawns).toBe(1)
  })
  /**
   * 文档载体那几家要把 settings 文档写进这一趟的临时目录 —— 探完必须整目录删掉,❌ 留在磁盘上。
   */
  it('占位凭据的临时目录探完即删', async () => {
    await useForkingAgent()
    let scratch = ''
    setProbePlatformEnvResolver(async (_pluginId, scratchDir) => {
      scratch = scratchDir
      await writeFile(join(scratchDir, 'probe-settings.json'), '{}', 'utf8')
      return { env: { GUGU_PROBE_MARK: 'yes' } }
    })
    await probeHarnessModelCatalog('claude', 'acp')
    expect(scratch).not.toBe('')
    expect(existsSync(scratch)).toBe(false)
  })
  /**
   * 占位凭据真的落到了第二趟进程的 env 上(fake agent 只在看到那个变量时才回档位)。
   */
  it('第二趟带着占位凭据跑,档位挂回 auth-required(kind 不变)', async () => {
    await useForkingAgent()
    setProbePlatformEnvResolver(async () => ({ env: { GUGU_PROBE_MARK: 'yes' } }))
    const state = await probeHarnessModelCatalog('qwen', 'acp')
    expect(spawns).toBe(2)
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    expect(state.selectedEffort).toBe('high')
  })
  /**
   * 第二趟读到的模型清单是**仪器造出来的**(占位凭据把模型钉成一个不存在的 id),不是读数。
   * 它一旦漏进 `auth-required`,界面就会列出一张用户根本跑不了的表 = 咕咕红线里的 fake。
   */
  it('第二趟的模型清单不许漏进结果 —— 那是占位凭据造出来的,不是读数', async () => {
    await useForkingAgent()
    setProbePlatformEnvResolver(async () => ({ env: { GUGU_PROBE_MARK: 'yes' } }))
    const state = await probeHarnessModelCatalog('qwen', 'acp')
    expect(spawns).toBe(2)
    expect(JSON.stringify(state)).not.toContain('probe-only')
  })

  it('Pi reads materialized model settings, preserves auth-required and removes the scratch directory', async () => {
    const { buildProbePlatformCredentials, PROBE_MODEL_ID } = await import('../../../../apps/desktop/electron/harness-catalog-probe-env')
    const entry = await fakeAgent(`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method !== 'session/new') return;
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return fail(msg.id, { code: -32000, message: 'Authentication required' });
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  const providers = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers;
  const model = providers[settings.defaultProvider].models.find((entry) => entry.id === settings.defaultModel);
  if (!model || !process.env.GUGU_PI_API_KEY) return fail(msg.id, { code: -32603, message: 'Missing model configuration' });
  return reply(msg.id, { sessionId: 'pi-probe', models: { availableModels: [{ modelId: model.id, name: model.name }] },
    configOptions: [{ id: 'thinking', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] });
}
`)
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [entry], env: {} }))
    let scratch = ''
    setProbePlatformEnvResolver(async (pluginId, scratchDir) => {
      scratch = scratchDir
      return buildProbePlatformCredentials(pluginId, scratchDir)
    })
    const state = await probeHarnessModelCatalog('pi', 'acp')
    expect(state).toMatchObject({ kind: 'auth-required', selectedEffort: 'high', efforts: [{ id: 'low' }, { id: 'high' }] })
    expect(JSON.stringify(state)).not.toContain(PROBE_MODEL_ID)
    expect(scratch).not.toBe('')
    expect(existsSync(scratch)).toBe(false)
  })

  it('returns a real second-probe failure instead of hiding it as sign-in required', async () => {
    const entry = await fakeAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'session/new') return fail(msg.id, process.env.GUGU_PROBE_MARK
    ? { code: -32603, message: 'Network unavailable' }
    : { code: -32000, message: 'Authentication required' });
}
`)
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [entry], env: {} }))
    setProbePlatformEnvResolver(async () => ({ env: { GUGU_PROBE_MARK: 'yes' } }))
    expect(await probeHarnessModelCatalog('pi', 'acp'))
      .toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('Network unavailable') })
  })
})
/**
 * 终止条件:**没有一条墙钟参与判「快慢」**。
 *
 * 之前那个 20s 握手总预算是设计性赛跑 —— 判的是「总共用了多久」,而那等于 harness 冷启时长,
 * 是机器性能与当下负载的函数(实测 d15 mimo 冷启 6.99s;本仓记过 mac1 opencode 11.8s 对
 * d15 3.2s = 3.7 倍)。于是同一个**健康**的 harness 闲时 `ready`、忙时 `unavailable`。
 *
 * 这一卷把两件事分开钉死:
 *  · 慢但**在推进** → 不管总共多久,必须给出正确读数(赛跑消失);
 *  · 起来了但**彻底不出声** → 必须被收掉(卡死进程不会永远占着 inFlight)。
 */
describe('终止条件:停摆判据取代握手总预算', () => {
  afterEach(() => {
    __setInactivityLimitForTest(null)
  })
  /**
   * 总时长**远超**停摆上限,但进程一直在出声 ⇒ 必须 `ready`。
   *
   * ⚠️ 这条就是那条赛跑的反例:旧代码(总预算)判的是总时长,这里必红;新代码判的是「有没有动静」。
   *
   * @@@virtual-guard-clock(#6259) — 守卫的钟是假的,子进程与管道是真的。
   * 从前用真钟:上限 500ms、子进程每 25ms 打一个字节。满载的 mac1(load 70+)上,子进程或本进程的事件
   * 循环整段得不到调度是常事,500ms 的真实静默照样出现 —— 那是调度器,不是被测行为(#5782 把比值从
   * 4 倍拉到 20 倍,#6259 实测 16 路并发仍 4–8/160 红)。现在只把 setTimeout/clearTimeout 换成假钟,
   * 子进程**每到一块输出**(守卫已按它重新 arm 之后)假钟才前进 400ms:任意两块输出之间的「静默」
   * 严格小于上限,而总时长 = 400ms × 块数 ≥ 两次应答 = 800ms > 上限。调度多慢都只影响真时长;
   * 子进程冷启动到第一拍之前假钟不走,#6270 撞到的「被判停摆的其实是启动」在这里不存在。
   */
  it('慢但一直在推进 → 总时长远超上限也照样读出来', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    let virtualElapsed = 0
    vi.mocked(spawn).mockImplementationOnce(((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      // 守卫的监听在 spawn 返回后的同一段同步代码里挂上,先于这里 —— 每块输出都是「先重新 arm,再走钟」。
      const tick = (): void => {
        virtualElapsed += 400
        vi.advanceTimersByTime(400)
      }
      queueMicrotask(() => {
        child.stdout?.on('data', tick)
        child.stderr?.on('data', tick)
      })
      return child
    }) as typeof spawn)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      __setInactivityLimitForTest(500)
      await useAgent(`
const beat = setInterval(() => process.stderr.write('.'), 25);
function handle(msg) {
  if (msg.method === 'initialize') return setTimeout(() => reply(msg.id, { protocolVersion: 1 }), 800);
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return setTimeout(() => {
    clearInterval(beat);
    reply(msg.id, { sessionId: 's', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'slow-but-alive', options: [
        { value: 'slow-but-alive', name: 'Slow but alive' },
      ] },
    ] });
  }, 800);
}
`)
      const state = await probeHarnessModelCatalog('slowpoke', 'acp')
      if (state.kind !== 'ready') throw new Error(`期望 ready,实得 ${state.kind}`)
      expect(state.models.map((m) => m.id)).toEqual(['slow-but-alive'])
      expect(virtualElapsed).toBeGreaterThan(500)
    } finally {
      vi.useRealTimers()
    }
  })
  /**
   * 起来了、管道开着、**永不应答**,而且自己不会退 —— `processFailed` 等不到它。
   * 不设上限就会永远占着 `inFlight`,那家 harness 的目录卡在 `unknown` 直到重启 = 静默失败。
   * 这是停摆守卫存在的**唯一**理由,所以必须有一条断言钉着它真的会咬。
   */
  it('起来了但彻底不出声 → 被停摆守卫收掉,报出原因', async () => {
    __setInactivityLimitForTest(200)
    await useAgent(`
function handle(msg) {}
setInterval(() => {}, 1000);
`)
    const state = await probeHarnessModelCatalog('mute', 'acp')
    expect(state.kind).toBe('unavailable')
    if (state.kind !== 'unavailable') return
    expect(state.reason).toContain('停摆')
  })
})
/**
 * 调度:目录读取离开关键路径。
 *
 * owner 2026-08-26 在 macOS 上实测切到 mimocode 要 **30s**,那 30s 整个压在
 * `agents.modelCatalog` 这条 RPC 上。这一卷钉的是「答」与「探」已经拆开。
 */
describe('调度:lookup 不等 harness 进程', () => {
  let spawns = 0
  let spawnWaiters: (() => void)[] = []
  function noteSpawn(): void {
    spawns += 1
    for (const wake of spawnWaiters.splice(0)) wake()
  }
  /**
   * 等到第 n 次 spawn 真的发生。
   *
   * ⚠️ ❌ 不用「睡一会儿再断言」:那是拿墙钟赌调度顺序 —— 慢机器上会假红,快机器上会**假绿**
   * (探测还没起就断言它起了,只要顺序碰巧对就过)。这里直接等事件本身;真的一直不 spawn,
   * 就由 vitest 自己的用例超时判死,失败信息还指着这条用例。
   */
  function waitForSpawnCount(n: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (spawns >= n) resolve()
        else spawnWaiters.push(check)
      }
      check()
    })
  }
  /**
   * 一个**永远答不完**的 harness —— 用来证明 lookup 真的没在等它。
   * 给了 `gate` 就让探测停在 spawn 解析这一步,直到用例放行。
   */
  async function useNeverAnsweringAgent(gate?: Promise<void>): Promise<void> {
    const entry = await fakeAgent(`
function handle(msg) {}
setInterval(() => {}, 1000);
`)
    setAcpSpawnResolver(async () => {
      noteSpawn()
      if (gate) await gate
      return { command: process.execPath, args: [entry], env: {} }
    })
  }
  beforeEach(() => {
    spawns = 0
    spawnWaiters = []
    __resetHarnessModelCatalogCache()
    setCatalogStore(null)
    setProbePlatformEnvResolver(async () => ({ env: {} }))
  })
  afterEach(async () => {
    await __drainProbesForTest()
    __setInactivityLimitForTest(null)
  })
  /**
   * ⚠️ 这条在改动前**必红/必挂**:旧的 `getHarnessModelCatalog` 会 await 整趟握手。
   * 这里那趟永远答不完(靠停摆守卫兜底),所以「立刻返回」是唯一能过的行为。
   */
  it('缓存全空 → 立刻回 unknown + refreshing,❌ 不等那趟探测', async () => {
    __setInactivityLimitForTest(3_000)
    // 探测停在 spawn 解析这一步,由用例放行。lookup 若等那趟探测,就等不到这道门打开 ——
    // 「不等」由「门还关着它就答了」这个事实证明,❌ 拿墙钟量它答得多快(慢机器上照样会慢过任何阈值)。
    let openGate!: () => void
    await useNeverAnsweringAgent(new Promise<void>((resolve) => { openGate = resolve }))
    const lookup = await awaitPending(
      'lookup 在探测被放行之前就回答',
      lookupHarnessModelCatalog('slowpoke', { leg: 'acp',  harnessVersion: '1' }),
    )
    expect(lookup.state.kind).toBe('unknown')
    expect(lookup.refreshing).toBe(true)
    openGate()
    await waitForSpawnCount(1)
    expect(spawns).toBe(1)
  })
  it('@@@catalog-probe-no-spin (#7649) 占位凭据抛出 → 落为 unavailable 并写缓存,lookup 必须收敛', async () => {
    // 配置物化失败:第一趟判出「需要登录」,第二趟写探针文件时抛。
    await useAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, {
    code: -32000,
    message: 'Authentication required',
    data: { authMethods: [{ id: 'pi_terminal_login', name: 'Log in from the terminal' }] },
  });
}
`)
    setProbePlatformEnvResolver(async () => {
      throw new Error('model catalog probe: pi placeholder credentials unavailable — its model is delivered by a session-bundle config file the probe does not materialize')
    })

    const first = await lookupHarnessModelCatalog('pi', { leg: 'acp', harnessVersion: '1' })
    expect(first.refreshing, '第一次问:后台刚起探测,这时候说还在读是对的').toBe(true)

    await __drainProbesForTest()

    const second = await lookupHarnessModelCatalog('pi', { leg: 'acp', harnessVersion: '1' })
    expect(second.refreshing, '探测收摊后仍说 refreshing ⇒ 渲染层每 700ms 再问一次,界面永远转圈').toBe(false)
    expect(second.state.kind, 'unknown = 还没探过;探过且炸了必须是 unavailable').toBe('unavailable')
    if (second.state.kind !== 'unavailable') return
    expect(second.state.reasonCode).toBe('probe-failed')
    expect(second.state.reason, '异常原文漏进了用户可见文案').not.toMatch(/placeholder credentials|session-bundle config file/)
  })

  it('缓存新鲜 → 直接给,refreshing=false,❌ 不再起进程', async () => {
    const entry = await fakeAgent(SESSION_WITH_MODELS)
    setAcpSpawnResolver(async () => {
      noteSpawn()
      return { command: process.execPath, args: [entry], env: {} }
    })
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(spawns).toBe(1)
    const lookup = await lookupHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(lookup.state.kind).toBe('ready')
    expect(lookup.refreshing).toBe(false)
    expect(spawns).toBe(1)
  })
  /**
   * 陈的清单先给出去,同时后台重探 —— 这是「别让用户对着转圈」的那一半。
   *
   * ⚠️ 另一半在渲染层:`refreshing` 必须真的驱动一次再询问,否则这份陈的会一直显示到重启。
   */
  it('缓存过期 → 先给陈的那份 + refreshing,后台再探', async () => {
    // 这条不判停摆:两趟都是会答的 agent,停摆上限用产品值。从前压到 3s,量的其实是冷启快不快(#6259)。
    const ready = await fakeAgent(SESSION_WITH_MODELS)
    setAcpSpawnResolver(async () => {
      noteSpawn()
      return { command: process.execPath, args: [ready], env: {} }
    })
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    expect(spawns).toBe(1)
    const lookup = await lookupHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2' })
    expect(lookup.state.kind).toBe('ready')
    if (lookup.state.kind !== 'ready') return
    expect(lookup.state.models.map((m) => m.id)).toEqual(['default', 'opus[1m]', 'haiku'])
    expect(lookup.refreshing).toBe(true)
    await waitForSpawnCount(2)
    expect(spawns).toBe(2)
  })
  /**
   * fail loud:后台那趟读出「坏了」时,缓存必须被**覆盖**成 unavailable ——
   * ❌ 不许因为「新的失败了」就继续把旧清单当读数发出去。
   */
  it('后台重探失败 → 覆盖掉陈的那份,❌ 不悄悄退回旧值', async () => {
    const ready = await fakeAgent(SESSION_WITH_MODELS)
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [ready], env: {} }))
    await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '1' })
    const broken = await fakeAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1 });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return fail(msg.id, { code: -32603, message: 'internal boom' });
}
`)
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [broken], env: {} }))
    const stale = await lookupHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2' })
    expect(stale.refreshing).toBe(true)
    const settled = await getHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2' })
    expect(settled.kind).toBe('unavailable')
    const after = await lookupHarnessModelCatalog('claude', { leg: 'acp',  harnessVersion: '2' })
    expect(after.state.kind).toBe('unavailable')
  })
})

/**
 * 后台探针永不弹浏览器(#6335):owner 什么都没点,屏幕上冒出过一页 Google 登录 —— 成因是 harness
 * 在 `session/new` 里发现「配了 OAuth 没凭据」就自己拉浏览器。判据读**子进程真正收到的** `BROWSER`
 * (假 agent 把它报成模型名),❌ 不读解析器入参。
 */
describe('后台探针屏蔽浏览器', () => {
  it('探针进程收到的 BROWSER 是 no-op(posix: true),盖过用户环境里的值', async () => {
    const entry = await fakeAgent(`
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's', configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'b', options: [
      { value: 'b', name: 'BROWSER=' + (process.env.BROWSER ?? '<unset>') },
    ] },
  ] });
}
`)
    setAcpSpawnResolver(async () => ({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH ?? '', BROWSER: '/usr/bin/open' },
    }))
    const state = await probeHarnessModelCatalog('opencode', 'acp')
    expect(state.kind).toBe('ready')
    const expected = process.platform === 'win32' ? 'BROWSER=/usr/bin/open' : 'BROWSER=true'
    expect(state.kind === 'ready' ? state.models.map((m) => m.name) : []).toEqual([expected])
  })
})

/**
 * #6246 两条腿的配置根可能不同(pi:终端腿读用户自己的 `~/.pi/agent`,ACP 腿读咕咕自有的根),
 * 那两份清单就不同。缓存键由组合根按声明给:分腿的家各探各的,其余两条腿共用一份、只探一次。
 */
describe('catalog per taskpage leg (#6246)', () => {
  const MODELS_FROM_ENV = `
function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'initialized') return;
  if (msg.method === 'session/new') return reply(msg.id, {
    sessionId: 'sess-leg',
    configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: process.env.FAKE_MODEL,
      options: [{ value: process.env.FAKE_MODEL, name: process.env.FAKE_MODEL }] }],
  });
}
`
  let probes: Array<[string, string]> = []
  beforeEach(async () => {
    probes = []
    __resetHarnessModelCatalogCache()
    const entry = await fakeAgent(MODELS_FROM_ENV)
    // The leg decides the config root the probe reads — here, which model the agent reports.
    setAcpSpawnResolver(async (pluginId, leg) => {
      probes.push([pluginId, leg])
      return {
        command: process.execPath,
        args: [entry],
        env: { FAKE_MODEL: leg === 'acp' ? 'gugu-root-model' : 'mine/own-a' },
      }
    })
  })
  afterEach(async () => {
    await __drainProbesForTest()
    setCatalogKeyResolver((pluginId) => pluginId)
  })
  const ids = (state: { kind: string; models?: Array<{ id: string }> }) =>
    state.kind === 'ready' ? state.models!.map((m) => m.id) : state.kind

  it('a family whose legs read different roots gets one catalog per leg', async () => {
    setCatalogKeyResolver((pluginId, leg) => (pluginId === 'pi' ? `${pluginId}@${leg}` : pluginId))
    expect(ids(await getHarnessModelCatalog('pi', { leg: 'tui', harnessVersion: '1' }))).toEqual(['mine/own-a'])
    expect(ids(await getHarnessModelCatalog('pi', { leg: 'acp', harnessVersion: '1' }))).toEqual(['gugu-root-model'])
    // Cached per leg: asking again probes nothing more.
    expect(ids(await getHarnessModelCatalog('pi', { leg: 'tui', harnessVersion: '1' }))).toEqual(['mine/own-a'])
    expect(probes).toEqual([['pi', 'tui'], ['pi', 'acp']])
  })

  it('[control] with one key per family both legs share one probe', async () => {
    await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion: '1' })
    await getHarnessModelCatalog('claude', { leg: 'tui', harnessVersion: '1' })
    expect(probes).toEqual([['claude', 'acp']])
  })
})
