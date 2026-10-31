import { ANTIGRAVITY_SESSION_TUI_ENABLED, GUGU_MCP_STDIO_RELAY_ENTRY_ENV } from './antigravity/session-bundle';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_BUNDLE_CHANNEL_MATERIALIZATION_FIELDS,
  resolveUnitDelivery,
  type CLIAgentPluginProvider,
  type HarnessSessionSurface,
  type ModelConfigDialect,
  type SessionCapabilityBundle,
  type SessionMaterialization,
  type SessionMaterializationField,
} from '@gugu/session-core/agents/plugins';
import { INSTALL_METHODS } from '@gugu/session-core/deps';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
  createAgentPluginRegistry,
  pluginRegistry,
} from '../registry';

// 物化时真去读工作目录的家(CodeBuddy 终端腿取它的 realpath),给一个真实存在的目录。
const NATIVE_CHANNEL_CWD = mkdtempSync(join(tmpdir(), 'gugu-native-channel-workspace-'));
afterAll(() => rmSync(NATIVE_CHANNEL_CWD, { recursive: true, force: true }));

const nativeUnitNames = ['mcp', 'env', 'model', 'autonomy', 'promptBlocks'] as const;
type NativeUnitName = (typeof nativeUnitNames)[number];

const probePackages = [
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
];
// ⚠️ 加方言必须同时加进这里。漏了的话这个探针会拿**别家的**方言去喂新适配器,
// 新适配器照约定 throw,探针把 throw 记成「这一格没兑现」—— 红是红了,但红在错误的地方,
// 读起来像「新适配器坏了」,其实是探针的清单过期。(本次加 qwen 时就这么撞的。)
const probeModelDialects: readonly ModelConfigDialect[] = [
  'codex-config-flags',
  'provider-env',
  'pi-models-json',
  'opencode-config-content',
  'qwen-openai-env',
  'gemini-env',
  'mimocode-config-content',
  'copilot-provider-env',
  'kimi-model-env',
  'qoder-byok-settings',
  // grok 2026-09-01(#4658):它的 model 适配器只认 'grok-xai-env',遇别家方言照约定 throw。
  // 漏登记 ⇒ model 探针拿不到一个 grok 收得下的方言 ⇒ 每个方言都 throw ⇒ 记成「这一格没兑现」。
  'grok-xai-env',
  'hermes-serve-env',
  'zcode-provider-table',
  'codebuddy-settings-env',
];
const probeAuthorizationEnv = 'GUGU_SESSION_MCP_AUTH_GUGU';

function channelProbeBundle(
  providerId: string,
  unit: NativeUnitName,
  populated: boolean,
  modelDialect: ModelConfigDialect = 'provider-env',
): SessionCapabilityBundle {
  // Claude session-page sessions deliberately do not receive arbitrary provider env. Their
  // native env projection is the session-scoped MCP URL/authorization pair (plus the
  // separately tested model projection), so use that legal channel as the positive probe.
  const claudeSessionEnvProbe = providerId === 'claude' && unit === 'env';
  const includeMcpProbe = (unit === 'mcp' || claudeSessionEnvProbe) && populated;
  return {
    mcpServers: includeMcpProbe
      ? [
          {
            name: 'gugu',
            url: 'http://127.0.0.1:44100/native-channel-probe',
            authorizationEnv: probeAuthorizationEnv,
          },
        ]
      : [],
    env: {
      GUGU_HOME: '/tmp/gugu-native-channel-probe',
      HOME: '/tmp/gugu-native-channel-user',
      CODEX_HOME: '/tmp/gugu-native-channel-user/.codex',
      ...(includeMcpProbe
        ? { [probeAuthorizationEnv]: 'Bearer native-channel-probe' }
        : {}),
      ...(unit === 'env' && populated && !claudeSessionEnvProbe
        ? { GUGU_NATIVE_CHANNEL_ENV_PROBE: 'native-channel-env-probe' }
        : {}),
    },
    // ⚠️ 带上 `platformProvider`:探的就是**平台会话**那一格。
    // 少了它,凡是「只在平台会话下注入」的适配器(qwen 就是,BYOK 会话必须一个键都不发,
    // 否则会顶掉用户自己选的端点)都会被判成「没兑现」—— 那是探针不真实造出来的假红,
    // 不是适配器的问题。对既有几家只是多注入一段 provider 声明,差分照样成立。
    model:
      unit === 'model' && populated
        ? {
            dialect: modelDialect,
            model: 'native-channel-model-probe',
            reasoningEffort: 'high',
            serviceTier: 'flex',
            platformProvider: {
              baseUrl: 'http://127.0.0.1:44100/native-channel-relay/v1',
              apiKey: 'native-channel-relay-token',
            },
            // 宿主对 gemini-env 还会把协议表原话(裸 relay 根 + key)写进 platformSettingsEnv;
            // 物化器只认它、缺了就 throw(#4700:拿上面带 /v1 的 baseUrl 当 GOOGLE_GEMINI_BASE_URL
            // 会拼成 /v1/v1beta 404)。探针要探的是「平台会话那一格能不能兑现」,所以要把宿主真会
            // 给的这份一并带上 —— 两者故意不同形,回读 baseUrl 的物化器在这里照样红。
            ...(modelDialect === 'gemini-env'
              ? {
                  platformSettingsEnv: {
                    GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:44100/native-channel-relay',
                    GEMINI_API_KEY: 'native-channel-relay-token',
                  },
                }
              : {}),
          }
        : null,
    autonomy: unit === 'autonomy' && populated ? { mode: 'full-access' } : null,
    promptBlocks:
      unit === 'promptBlocks' && populated
        ? { platform: '<gugu_platform>NATIVE_CHANNEL_PROMPT_PROBE</gugu_platform>\n' }
        : {},
    packages: probePackages,
  };
}

function probeFields(
  providerId: string,
  surface: HarnessSessionSurface,
  unit: NativeUnitName,
  declaredFields: readonly SessionMaterializationField[],
): readonly SessionMaterializationField[] {
  // Claude's acp leg names the system-meta channel. The materializer returns the semantic
  // session prompt and the task ACP host wraps it into _meta.systemPrompt, so probe that semantic
  // projection directly. ⚠️ 只豁免协议腿:终端腿('prompt-file-argv')自己就产出 artifact + argv,
  // 照声明的字段探 —— 豁免整家会让终端腿「声明了提示档却一个字没落盘」照样绿。
  if (providerId === 'claude' && surface === 'acp' && unit === 'promptBlocks') return ['prompt'];
  return declaredFields;
}

function normalizedFields(
  materialization: SessionMaterialization,
  fields: readonly SessionMaterializationField[],
): string {
  const selected = Object.fromEntries(fields.map((field) => [field, materialization[field]]));
  return JSON.stringify(selected, (_key, value) =>
    typeof value === 'string'
      ? value.replace(
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
          '<uuid>',
        )
      : value,
  );
}

function probeNativeUnitSurface(
  provider: CLIAgentPluginProvider,
  surface: HarnessSessionSurface,
  unit: NativeUnitName,
  fields: readonly SessionMaterializationField[],
): { populated: boolean; detail: string } {
  const behavior = provider.behavior.sessionBundle;
  if (!behavior) return { populated: false, detail: 'materializer missing' };

  const fieldsToProbe = probeFields(provider.metadata.id, surface, unit, fields);
  const dialects = unit === 'model' ? probeModelDialects : [probeModelDialects[0]];
  const failures: string[] = [];
  for (const dialect of dialects) {
    try {
      const empty = behavior.materialize(
        { surface, lifecycle: 'fresh', cwd: NATIVE_CHANNEL_CWD },
        channelProbeBundle(provider.metadata.id, unit, false, dialect),
      );
      const populated = behavior.materialize(
        { surface, lifecycle: 'fresh', cwd: NATIVE_CHANNEL_CWD },
        channelProbeBundle(provider.metadata.id, unit, true, dialect),
      );
      if (
        normalizedFields(populated, fieldsToProbe) !== normalizedFields(empty, fieldsToProbe)
      ) {
        return { populated: true, detail: dialect + ': mapped field changed' };
      }
      failures.push(dialect + ': no mapped field changed');
    } catch (error) {
      failures.push(dialect + ': ' + (error as Error).message);
    }
  }
  return { populated: false, detail: failures.join('; ') };
}

describe('pluginRegistry', () => {
  // @@@permission-four-rungs — 判据必须打在**真实注册表**上,不是测试自己写的 spec fixture。
  // 上一版只测了 fixture:把 claude 的 planFlag 整行删掉,四档 argv 判据照样全绿 ——
  // 声明和 flag 是两处,漏一处就"界面摆着规划档、发下去却是别的行为"。
  it('每个声明了某一档的 harness,都必须真能把那一档发下去', () => {
    const base = {
      cli: '/bin/AGENT',
      permissionMode: 'edit',
      cliSessionId: 'judge-session',
      isResuming: false,
      model: '',
    } as const;

    const checked: string[] = [];
    for (const provider of pluginRegistry.getAll()) {
      const modes = provider.capabilities.autoApprove.modes;
      const buildCommand = provider.behavior?.prompt?.buildCommand;
      if (!modes || !buildCommand) continue;
      // Permission modes for an ACP-only adapter are selected through the protocol rather
      // than TUI argv. There is no session-TUI command surface on which argv uniqueness can be
      // judged, so leave those modes to the ACP mode contract. "No session-TUI leg" covers both
      // shapes: the leg is declared with identity none, or it is not declared at all (hermes).
      const tuiLeg = provider.capabilities.sessionBundle?.sessionpage['tui'];
      if (!tuiLeg || tuiLeg.identity === 'none') continue;

      const argvByRung = new Map<string, string>();
      for (const rung of ['plan', 'read-only', 'edit', 'full-access'] as const) {
        const entry = modes[rung];
        // 只在聊天面板腿兑现的档(`legs` 不含 tui,如 antigravity 的只读)终端腿不摆,也不该有 argv。
        if (!entry || (entry.legs && !entry.legs.includes('tui'))) continue;
        argvByRung.set(rung, buildCommand({ ...base, permissionMode: rung }).args.join(' '));
        checked.push(provider.metadata.id + ':' + rung);
      }

      // 声明了 N 档就必须产出 N 个**互不相同**的 argv。两档撞车 = 其中一档静默变成另一档:
      // 不报错、不红别的用例,只在真机上表现为"选了这档却是那档的行为"。
      expect(
        new Set(argvByRung.values()).size,
        provider.metadata.id + ' 的档位 argv 撞车了: ' + JSON.stringify([...argvByRung])
      ).toBe(argvByRung.size);
    }

    // 阳性对照:这条判据真的扫到了东西,而不是因为一个都没匹配上而平凡通过。
    expect(checked).toContain('claude:plan');
    expect(checked).toContain('codex:read-only');
    expect(checked).toContain('opencode:plan');
  });

  it('keeps the exact 30-entry registry order', () => {
    expect(pluginRegistry.ids()).toEqual([
      'codex',
      'claude',
      'grok',
      'devin',
      'qwen',
      'droid',
      'antigravity',
      'cursor',
      'copilot',
      'amp',
      'commandcode',
      'gemini',
      'opencode',
      'hermes',
      'auggie',
      'kimi',
      'kilocode',
      'kiro',
      'cline',
      'continue',
      'codebuff',
      'mistral',
      'junie',
      'oh-my-pi',
      'pi',
      'qoder',
      'mimocode',
      'zero',
      'zcode',
      'codebuddy',
    ]);
  });

  it('declares every adapter session surface explicitly', () => {
    expect(
      Object.fromEntries(
        pluginRegistry
          .getAll()
          .map((provider) => [provider.metadata.id, provider.capabilities.sessionBundle.surfaces])
      )
    ).toEqual({
      codex: ['acp', 'app-server'],
      claude: ['acp', 'tui'],
      grok: ['acp', 'tui'],
      devin: ['acp', 'tui'],
      qwen: ['acp', 'tui'],
      droid: ['acp', 'tui'],
      // #6335:两条腿、两个程序 —— 聊天面板 `agy_acp_server` + 终端 `agy`(2026-09-24 第二层接回)。
      // Windows 上终端腿不开(`ANTIGRAVITY_SESSION_TUI_ENABLED`,理由见该家 session-bundle)。
      antigravity: ANTIGRAVITY_SESSION_TUI_ENABLED ? ['acp', 'tui'] : ['acp'],
      cursor: ['acp', 'tui'],
      copilot: ['acp', 'tui'],
      amp: ['tui'],
      commandcode: ['tui'],
      gemini: ['acp'],
      opencode: ['acp', 'tui'],
      // hermes 只开 Work(ACP)腿:终端腿咕咕还没接入站通道,干脆不给用户选 Code。
      hermes: ['acp'],
      auggie: ['acp', 'tui'],
      // ⚠️ kimi 的终端腿 2026-08-28 **重新开启**(随独立 home 一起)。关它的理由只有一条:
      //    咕咕的 MCP 在 kimi 命令行上唯一的载体是**用户的全局** `~/.kimi-code/mcp.json`。
      //    独立 home 之后咕咕写的是自己那份,那条理由消失了。见
      //    impl/kimi/session-bundle.ts 的 `KIMI_SESSION_TUI_ENABLED` 与 `mcpConfigArtifact`。
      kimi: ['acp', 'tui'],
      kilocode: ['acp', 'tui'],
      kiro: ['acp', 'tui'],
      cline: ['acp', 'tui'],
      continue: ['tui'],
      codebuff: ['tui'],
      mistral: ['acp', 'tui'],
      junie: ['acp', 'tui'],
      'oh-my-pi': ['acp', 'tui'],
      pi: ['acp', 'tui'],
      qoder: ['acp', 'tui'],
      mimocode: ['acp', 'tui'],
      zero: ['tui'],
      zcode: ['acp'],
      codebuddy: ['acp', 'tui'],
    });
  });

  it('covers the #3816 taskpage 5/24/2 declaration table without claiming unsupported legs', () => {
    // ⚠️ 2026-09-21(#6097):autohand / charm / freebuff / goose / jules / letta / rovo 七家随插件
    //    一起删掉,这一组 31 → 24。数字变小**不是**这一组少声明了腿,是家数少了。
    const addressable24 = [
      // #6335:antigravity 2026-09-24 回到这一组 —— 终端腿(`agy`)以托管配置根重新接上(Windows 除外)。
      'amp', ...(ANTIGRAVITY_SESSION_TUI_ENABLED ? ['antigravity'] : []), 'auggie', 'cline', 'codebuff', 'commandcode',
      'continue', 'copilot', 'devin', 'droid',
      // ⚠️ grok 2026-09-01 **退出**这一组(#4658):它的 tui 腿从来没被量过(units 四维全
      //    unverified),此前挂着 `addressable/local-session` 是**过声明** —— A 读数里那条静默假死
      //    正是「声明矩阵说腿可用、物化却兑现不出」撞出来的。置 none/none。终端腿首句通道待 #4653
      //    链定语义再开(边界 ②)。grok 的协议腿已在 #4716 升为 addressable/router，但终端腿仍关闭。
      // ⚠️ kimi 2026-08-28 **回到**这一组:终端腿重开,`sessionpage['tui']` 跟着回来。
      //    (dev 上它一度退出 —— 那是终端腿开关关着的读数;本分支把开关翻回 true。)
      'junie', 'kilocode', 'kimi', 'kiro', 'mimocode', 'mistral', 'oh-my-pi',
      // opencode 自 2026-08-28 起在列(#4406):终端腿按实测补上,取证见 impl/opencode/session-bundle.ts。
      'opencode',
      'pi', 'qoder', 'qwen', 'zero',
      // codebuddy 2026-10-19(#7525):终端腿 `--mcp-config` + `--append-system-prompt`,本机会话通道。
      'codebuddy',
    ];
    // 17（原 18，mimocode 已于 2026-08-25 迁出）—— 这些家的 ACP 腿咕咕还没投递身份与消息通道。
    // grok 自 2026-09-02 起迁入 addressable/router（idle-only；#4716），不再属于此组。
    // 16（原 17，kimi 已于 2026-08-25 迁出）
    // 13（原 14，qwen 于 2026-08-31 翻转；copilot 同日翻转，A/B 见 #4516；
    //    droid 已于 2026-08-30 翻转:加家 = impl/droid 声明行,A/B 见 session-injection
    //    节点 droid-task-acp-onboarding eval;next-tool-call 有 #4490 专项读数）
    // 9（原 13,goose 于 2026-09-21 随插件删掉 —— #6097;走的是家数,不是哪一腿被接通）
    //
    // ⚠️ qwen 的旧读数（exact-head「ACP 正向未通过」）**不成立**：那次拿到的 `[NO_REPLY]`
    //    是 `<gugu_silence>` 教给 agent 的沉默哨兵，模型说出它恰恰证明消息到了（qwen 自己的
    //    会话文件逐字记着那次的暗号），把同一段正文重放 5 次复现 0/5。#4530 的
    //    `e2e/agent/qwen-acp-delivery-4530.spec.ts`(#6270 已删) 是它的产品闭环 A/B。
    // 2026-09-21(#6097):goose 随插件删掉,这一组 10 → 9。
    const sessionAcpNone9 = [
      'auggie', 'cline', 'devin',
      'junie', 'kilocode', 'kiro', 'mistral', 'oh-my-pi', 'qoder',
    ];
    for (const providerId of addressable24) {
      const provider = pluginRegistry.get(providerId)!;
      // OpenCode and MiMo Code use the provider-agnostic serve/attach host adapter;
      // droid retains its daemon adapter while the remaining providers stay local-session.
      const expected = providerId === 'opencode' || providerId === 'mimocode'
        ? { identity: 'addressable', messageTransport: 'router', hostAdapter: 'opencode-serve-attach-v1' }
        : {
            identity: 'addressable',
            messageTransport: 'local-session',
            ...(providerId === 'droid' ? { hostAdapter: 'droid-daemon-v1' } : {}),
            ...(providerId === 'qwen'
              ? {
                  promptInput: {
                    multiline: 'plain',
                    evidence: expect.stringContaining('QwenLM/qwen-code@98a9c9641586'),
                  },
                }
              : {}),
            // #4670 —— qoder 没有原生入站通道;`inbound: none` 表示没有原生 leg。
            // kimi 2026-09-04 起不在这里:它的 pty 注入路修通后(粘贴突发判定关掉,
            // 见 kimi/session-bundle.ts `tuiEditorOverlay`),终端腿收得进,与其余腿同形。
            // ⚠️ 这一格是显式登记的 —— 入站轴缺席即"收得进",所以能收的那些腿一个字都不用写。
            ...(providerId === 'qoder' ? { inbound: 'none' as const } : {}),
          };
      expect(provider.capabilities.sessionBundle.sessionpage['tui'], providerId).toEqual(expected);
    }

    const sessionAcpProviders = pluginRegistry.getAll()
      .filter((provider) => {
        const integration = provider.capabilities.sessionBundle.sessionpage['acp'];
        return integration?.identity === 'addressable' && integration.messageTransport !== 'none';
      })
      .map((provider) => provider.metadata.id);
    // kimi 自 2026-08-25 起也在列：ACP 腿的 gugu-im 走 `session/new` 的 mcpServers（零落盘）。
    // ⚠️ 2026-08-27：它当初进这张表时压着的第二个前提（身份自述走 run-scoped
    //    `$KIMI_CODE_HOME/SYSTEM.md`）**已经没了** —— 那个合成 home 把用户的 kimi login
    //    凭据和咕咕自己的 hook 一起搬走了，撤掉它之后这一家没有会话级系统提示载体。
    //    「留在这张表里还是撤出去」是产品决定，理由与两边代价记在
    //    `impl/kimi/session-bundle.ts` 的 `sessionpage['acp']` 抬头，待 owner 裁。
    // mimocode 自 2026-08-25 起也在列：它的 ACP 腿拿到了 gugu-im（配置文档里的 `mcp` 块，
    // 实测假端点收到真实请求、工具进了模型工具表）与身份自述（`instructions`，需同时打开
    // `MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT`）。缺其一都不该声明 addressable。
    // qwen 自 2026-08-31 起在列：产品闭环 A/B 见 `e2e/agent/qwen-acp-delivery-4530.spec.ts`(#6270 已删)
    // （同轮 codex 阳控通过；`none/none` 反向变异让判据红在 Chat UI 开关那一行）。
    // gemini 自 2026-09-01 起在列(#4655):ACP 腿的 gugu MCP 走 `session/new` 的 mcpServers
    // (实测 0.57.0 initialize→tools/list 全通、工具进模型请求体,前置 --skip-trust 与宿主
    // node≤25,见 impl/gemini/session-bundle.ts 抬头),身份自述走 session-context。
    // 产品闭环 A/B 照 qwen-4530 的形状,B 落地前这行只表示「产品会选择并启动这条路径」。
    // antigravity 自 2026-09-23 起在列(#6335):官方 ACP 服务的 session/new mcpServers(http 与 stdio)
    // 实测走到 tools/list、工具进模型请求体,身份自述走 session-context(marker 进请求体),
    // 见 impl/antigravity/session-bundle.ts 抬头。
    // zcode 自 2026-10-17 起在列(#7385):桥 @gugu-acp/zcode-acp 把 `session/new.mcpServers` 原样交给 ZCode app-server,
    // 注入的 stdio 工具被模型调到(mcp__<server>__<tool>);身份自述走 session-context。见 impl/zcode/session-bundle.ts 抬头。
    expect(sessionAcpProviders).toEqual(['codex', 'claude', 'grok', 'qwen', 'droid', 'antigravity', 'cursor', 'copilot', 'gemini', 'opencode', 'hermes', 'kimi', 'pi', 'mimocode', 'zcode', 'codebuddy']);

    const localSessionTransportProviders = pluginRegistry.getAll()
      .filter((provider) => provider.capabilities.sessionBundle.sessionpage['tui']?.messageTransport === 'local-session')
      .map((provider) => provider.metadata.id);
    // OpenCode and MiMo Code use serve/attach; the remaining addressable TUI legs stay local-session.
    expect(localSessionTransportProviders.sort()).toEqual(
      addressable24.filter((id) => id !== 'opencode' && id !== 'mimocode').sort(),
    );

    expect(sessionAcpNone9.every((providerId) =>
      pluginRegistry.get(providerId)!.capabilities.sessionBundle.sessionpage['acp']?.identity === 'none'
      && pluginRegistry.get(providerId)!.capabilities.sessionBundle.sessionpage['acp']?.messageTransport === 'none'
    )).toBe(true);

    // 第三轴 injection(spec session-injection):声明必须携可复核证据坐标；
    // Claude acp 走 ACP steering 扩展，tui 仍保留 rendezvous 读数。
    expect(pluginRegistry.get('claude')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('agentclientprotocol/claude-agent-acp@3e23c5b960b6'),
          deviations: expect.stringContaining('_session/steering'),
        },
      },
      'tui': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('F1R3'),
          // #636 两面(#4500 已收):当前轮有后续工具边界⇒同轮 next-tool-call(产品 F1R3 直测);
          // 无 further boundary⇒落下一轮。此前据「落下一轮」拟降档的判读已撤,见 deviations。
          deviations: expect.stringContaining('rendezvous'),
        },
      },
    });
    expect(pluginRegistry.get('codex')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('product ACP R9'),
        },
      },
      'tui': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: { timing: 'next-tool-call', evidence: expect.stringContaining('turn/steer 6/6 同轮') },
        // 第四轴(#4525):只有 codex 声明了可见终端的按键解析约束——正文与提交键不得落进同一次 read。
        terminalInput: {
          submitSeparationMs: 25,
          evidence: expect.stringContaining('4525'),
          measurement: expect.stringContaining('15ms'),
        },
      },
    });
    // 这一格只有 codex 有:没量到这条约束的家一律不声明,也就一毫秒都不多付。
    const terminalInputDeclarers = pluginRegistry.getAll()
      .filter((provider) => provider.capabilities.sessionBundle.sessionpage['tui']?.terminalInput)
      .map((provider) => provider.metadata.id);
    expect(terminalInputDeclarers).toEqual(['codex']);
    expect(pluginRegistry.get('opencode')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: { timing: 'next-tool-call', evidence: expect.stringContaining('anomalyco/opencode@a3647eb025c7') },
      },
      // 终端腿经 serve/attach 升档(owner 升档 + #4521):专用 host adapter,serve 跑推理、attach 只渲染,投递经既有 router。
      'tui': { identity: 'addressable', messageTransport: 'router', hostAdapter: 'opencode-serve-attach-v1' },
    });
    expect(pluginRegistry.get('gemini')!.capabilities.sessionBundle.sessionpage).toEqual({
      // next-tool-call 铺开第二批(2026-09-01):gemini ACP 腿升档,实测
      // busy 3/3 + idle 1/1,假 cancelled 同 qwen。
      // 判假:去掉 injection → resolver 回落 idle-only,本断言即红。
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('google-gemini/gemini-cli@6b0ae9a6c37a'),
          deviations: expect.stringContaining('假 cancelled'),
        },
      },
    });
    // hermes 2026-10-04:只开 ACP 腿(整表 toEqual 顺带钉住「没有 tui」)。serve 桥的忙时插话是
    // `session.steer`(下一个工具边界进同一轮);冷启动窗口由桥扣到 `message.start` 再 steer,所以升 next-tool-call。
    expect(pluginRegistry.get('hermes')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('NousResearch/hermes-agent@ddde0670104f'),
        },
      },
    });
    expect(pluginRegistry.get('grok')!.capabilities.sessionBundle.sessionpage['acp']).toEqual({
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'idle-only',
        evidence: expect.stringContaining('issuecomment-5498265083'),
        deviations: expect.stringContaining('after the active turn ends'),
      },
    });
    // next-tool-call 铺开第一批(2026-09-01):qwen/copilot 的 ACP 腿升档到 next-tool-call,
    // 实测 busy 3/3 + idle 1/1。
    // 判假:去掉这条 injection 声明 → resolveSessionpageSessionIntegration 回落缺席=idle-only,本断言即红。
    expect(pluginRegistry.get('qwen')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('QwenLM/qwen-code@09825973e7d3'),
          // 假 cancelled 靠 cell 移交守卫覆盖 —— 机器可见,不藏注释。
          deviations: expect.stringContaining('假 cancelled'),
        },
      },
      'tui': {
        identity: 'addressable',
        messageTransport: 'local-session',
        promptInput: {
          multiline: 'plain',
          evidence: expect.stringContaining('QwenLM/qwen-code@98a9c9641586'),
        },
      },
    });
    expect(pluginRegistry.get('copilot')!.capabilities.sessionBundle.sessionpage).toEqual({
      'acp': {
        identity: 'addressable',
        messageTransport: 'router',
        injection: {
          timing: 'next-tool-call',
          evidence: expect.stringContaining('@github/copilot/v/1.0.82'),
          // interrupt+fold 与 droid 不打断的 fold 有别 —— 机器可见,不藏注释。
          deviations: expect.stringContaining('打断'),
        },
      },
      'tui': { identity: 'addressable', messageTransport: 'local-session' },
    });
    // 保持 idle-only 的两家(同一批实测):kimi 忙时被 harness 拒(-32600 turn.agent_busy),
    // mimocode 忙时静默丢弃(#4489) —— 都**没有** injection 声明,缺席=最保守 idle-only。
    // 这是「声明了却到不了会红」的对称对照:给它们加 next-tool-call 就是假绿。
    for (const providerId of ['kimi', 'mimocode'] as const) {
      expect(
        pluginRegistry.get(providerId)!.capabilities.sessionBundle.sessionpage['acp'],
        providerId,
      ).not.toHaveProperty('injection');
    }
    // 2026-09-21(#6097):这里原本还钉着 openclaw 的「一条腿都不声明(sessionpage 空表)」——
    // 那一家被整个删掉了,今天注册表里**没有**空 sessionpage 的家。⇒ 这条正例没有载体,
    // 一并撤掉;❌ 别换成 `toEqual({})` 以外的弱形式留在这儿假装还在测。
    for (const providerId of sessionAcpNone9) {
      expect(pluginRegistry.get(providerId)!.capabilities.sessionBundle.sessionpage['acp'], providerId).toEqual({
        identity: 'none',
        messageTransport: 'none',
      });
    }
    // opencode 的 tui 腿自 #4406 起是实测申明,形状已在上方 toEqual 整表钉住。
    // grok 的 tui 腿如实关着,`reason` 记着为什么;单独钉一条正向棘轮,防止未来把它悄悄改回或抹掉。
    expect(pluginRegistry.get('grok')!.capabilities.sessionBundle.sessionpage['tui']).toEqual({
      identity: 'none',
      messageTransport: 'none',
      reason: expect.stringContaining('#4653'),
    });
  });

  it('keeps the acp steering floor explicit for the supported families', () => {
    const steeringFamilies = ['claude', 'codex', 'opencode', 'qwen', 'copilot'] as const;
    for (const providerId of steeringFamilies) {
      expect(
        pluginRegistry.get(providerId)!.capabilities.sessionBundle.sessionpage['acp']?.injection?.timing,
        `${providerId} acp steering tier`,
      ).toBe('next-tool-call');
    }
  });

  it('materializes every declared native unit through its contract channel', () => {
    // antigravity 终端腿的 MCP 条目指向随 app 发的 stdio 中继;宿主在 spawn 前登记它的入口(`registerGuguMcpStdioRelayEntry`)。
    vi.stubEnv(GUGU_MCP_STDIO_RELAY_ENTRY_ENV, '/app/dist-electron/runtime/gugu-mcp-stdio-relay.mjs');
    const checks: {
      label: string;
      populated: boolean;
      surfaces: { surface: HarnessSessionSurface; populated: boolean; detail: string }[];
    }[] = [];

    for (const provider of pluginRegistry.getAll()) {
      const descriptor = provider.capabilities.sessionBundle;
      if (descriptor.surfaces.length === 0) continue;
      for (const unit of nativeUnitNames) {
        const delivery = descriptor.units[unit];
        // 按腿声明(`kind:'per-surface'`)—— **每条腿各记一格,且每格只看自己那条腿**。
        // ❌ 不许沿用下面扁平写法的 `some()`:那等于一条腿兑现了就替另一条腿背书,
        //    正是 behavior `agent-config-boundary` 禁的「借另一条腿的通道假装它有」。
        // ❌ 也不许在上面那句 `kind !== 'native'` 里被 continue 掉 —— per-surface 的 kind
        //    两个都不是,漏掉这一支就是**整家整维静默不受检**。
        if (delivery.kind === 'per-surface') {
          for (const surface of descriptor.surfaces) {
            const leaf = resolveUnitDelivery(delivery, surface);
            if (leaf.kind !== 'native') continue;
            const reading = {
              surface,
              ...probeNativeUnitSurface(
                provider,
                surface,
                unit,
                SESSION_BUNDLE_CHANNEL_MATERIALIZATION_FIELDS[leaf.channel]
              ),
            };
            checks.push({
              label: `${provider.metadata.id}.${unit}@${surface} (${leaf.channel})`,
              populated: reading.populated,
              surfaces: [reading],
            });
          }
          continue;
        }
        if (delivery.kind !== 'native') continue;
        const fields = SESSION_BUNDLE_CHANNEL_MATERIALIZATION_FIELDS[delivery.channel];
        const surfaces = descriptor.surfaces.map((surface) => ({
          surface,
          ...probeNativeUnitSurface(provider, surface, unit, fields),
        }));
        checks.push({
          label: provider.metadata.id + '.' + unit + ' (' + delivery.channel + ')',
          populated: surfaces.some((reading) => reading.populated),
          surfaces,
        });
      }
    }

    // 40 = 34 + qwen.model + mimocode.model + copilot.model + copilot.autonomy('argv')
    //      + opencode.autonomy + mimocode.autonomy（都是 permission 块 ⇒ 'process-config'）
    //      + qwen.autonomy（`--approval-mode` ⇒ 'argv'）
    //      + mimocode 的 mcp / env / promptBlocks（配置文档那条通道接通，见该家 units 注释）
    //      + copilot.env（前缀白名单交给子进程 ⇒ 'child-process'）
    //      + kimi 的 mcp / env / model（见该家 units 注释）
    //        ⚠️ 2026-08-27 曾少一格:kimi.promptBlocks 从 native 退成
    //        `none + violates-zero-residue`(撤掉合成 `KIMI_CODE_HOME` 后 SYSTEM.md
    //        没有会话级落点了)。**同日补回终端腿那一格** —— `--agent-file` 一直在顶层
    //        `kimi` 命令上,当时判它「用不了」只对了一半:与 -S/-C 互斥是真的,但缺的是把
    //        `isResuming` 递到物化层(现已补),不是没法挡。协议腿那一格仍是欠账,没假装补上。
    //      + qoder 的 model / autonomy（settings 文档 + 两个 QODER_* 变量 ⇒ 'process-config'）
    //      + kimi.promptBlocks **两格**：`@acp`='session-context'（没有系统位，同一段话
    //        以用户级载体进首轮）+ `@tui`='prompt-file-argv'（`--agent-file`）。
    //        ⚠️ 2026-08-28 一度减为一格（`KIMI_SESSION_TUI_ENABLED = false` 让 `surfaces` 不含
    //        `tui`，这个循环只数**真声明了的**腿）；同日随独立 home 把开关翻回 `true`，
    //        于是**+2**：promptBlocks 的终端腿那一格回来了，`kimi.mcp@tui` 也从
    //        `none` 变成 native（'config-file'，咕咕写自己那份 mcp.json）。
    // 这个数字是**反空转计数器**：
    // 没有它,下面那个 for 循环在 checks 为空时也全绿 —— 「每一格都兑现了」会变成一句
    // 对空集为真的空话。所以加一格 native 单元就必须在这里显式承认一次。
    // 合 dev(2026-08-31)后的普查数 = **54**,而且这个数是对得上的,不是照着输出改的:
    //   合并基 51 ＋ 本分支 +2(kimi 终端腿回来:`mcp@tui` 与 `promptBlocks@tui`)
    //   ＋ dev +1(qwen session-TUI MCP 的显式 user-config writer)= 54。
    // #4655(2026-09-01)gemini +4:gemini 的 `acp` 腿从 surfaces=[] 开出来,
    //   它原有的 mcp('acp-session')/env('child-process')两格第一次有腿可落,
    //   加新接的 model('process-config')与 promptBlocks('session-context')。
    //   ＋1(2026-09-01,#4657 层4):`copilot.mcp@tui` 从 `none+unverified` 升为
    //     native('config-file-argv',run-scoped 文件 + `--additional-mcp-config @路径`,
    //     连接侧实测见该家 descriptor 注释)。
    // 54(合并基)＋4(gemini)＋1(copilot)= **59**。
    // ⚠️ 两边的增量互不重叠,所以直接相加成立;哪天对不上就说明有一格是**谁都没声明**却冒出来的,
    //    那正是这个反空转计数器要抓的东西 —— ❌ 别把它改成实际输出了事。
    //
    // grok 2026-09-01(#4658)ACP 腿五维接通 ⇒ **+5**,59 → **64**。逐格是(❌ 不是改数字了事):
    //   · mcp@acp('acp-session') —— per-surface,只有 acp 那条 native,记 1 格;
    //   · env(flat 'child-process') —— flat native 全家记 1 格(不按腿拆);
    //   · model@acp('process-config') —— per-surface,1 格(探针须带 'grok-xai-env' 方言,见上);
    //   · autonomy@acp('process-config') —— per-surface,1 格;
    //   · promptBlocks@acp('session-context') —— per-surface,1 格。
    //   终端腿四维全 unverified(none),一格都不进 —— 与 sessionpage['tui']=none/none 同一笔诚实账。
    // ⚠️ 合 dev 后基数是 **59**(上面共同区:54 合并基 ＋ gemini +4 #4655 ＋ copilot +1 #4657),不是我这条
    //    分支当初分叉时的 54;grok 的 +5 与 gemini/copilot 的增量互不重叠(不同家)⇒ 59 + 5 = 64。基数变了
    //    数字就得跟着变,但仍是**逐格加出来的**,不是照测试输出改的。
    // Cursor ACP 2026-09-02 接通两格(env, promptBlocks) ⇒ **+2**,64 → **66**。
    //    MCP/model/autonomy/extension 与 session-TUI 均不进入 native checks。
    // Hermes ACP 2026-09-02 接通两格(model, promptBlocks) ⇒ **+2**,66 → **68**。
    //    MCP 在 0.21.0 ACP 工具表缺陷下保持 none+unverified；env 是 flat 一格但已有基数计入,
    //    autonomy/extension 仍 none,session-TUI 全 none。
    //    数字仍按 descriptor 逐格加出来,不是照测试输出改的。
    // qwen 2026-09-03(#4834)⇒ **+1**,68 → **69**。逐格:
    //   · promptBlocks@tui:`none + unverified` → native('argv-append',
    //     `--append-system-prompt`,交互腿实测见该家 descriptor)—— 新增 1 格;
    //   · mcp@tui:`user-config` → 'system-config-overlay'。**换通道不换格数**,
    //     它本来就是 native,所以这一笔 +0 —— ❌ 别因为改动大就顺手加一。
    // qwen 2026-09-07 ⇒ **+1**,69 → **70**。逐格(❌ 不是照输出改的):
    //   · model:原本是**扁平** native('process-config')= 全家 1 格;
    //     现在按腿声明,两条腿都是 native ⇒ 记 2 格
    //     ('acp' 仍 'process-config';'tui' 是 'system-config-overlay',
    //      因为「这条会话还能换到哪几条」是个**列表**,环境变量表达不了,只有文件写得下)。
    //   ⇒ 1 格变 2 格,净 +1。其余单元一个字没动。
    // Pi 2026-09-08: session-TUI model moved to the measured Gugu-owned models.json overlay,
    // while its MCP runtime event channel remains native
    // ⇒ **+2**,70 → **72**。与 qwen 增量是不同家、不同单元，互不重叠。
    // Pi 2026-09-08(#5252)开出 session-ACP 腿 ⇒ **+1**,72 → **73**。逐格加出来的,❌ 不是照输出改的:
    //   · mcp / env / model / promptBlocks 四维**仍是扁平** native ⇒ 各自仍只记 1 格,+0。
    //     扁平不是偷懒:这条腿递不进任何 pi argv(adapter 用固定 argv 起 `pi --mode rpc`),
    //     两条腿最终都只能骑「子进程环境 + 咕咕自有配置根」,所以这四维**答案本来就相同**。
    //   · autonomy:原本是扁平 `none + unverified`(一格都不进);现在按腿声明,
    //     只有 `acp` 那条是 native('process-config' —— 咕咕按本次会话的档算出一个
    //     子进程环境变量,事件模块据它在 tool_call 边界发问)⇒ **新增 1 格**。
    //     终端腿如实留 none(那条腿的 confirm 往返没量过),不进 checks。
    //   ⇒ 净 +1。
    // claude 2026-09-21(#5852)⇒ **+1**,73 → **74**。逐格(❌ 不是照输出改的):
    //   · promptBlocks:原本是**扁平** native('system-meta')= 全家 1 格 —— 而终端腿实际走的是
    //     argv 正文,那一格是被协议腿的通道名顺带盖住的。现在按腿声明,两条腿都是 native ⇒ 记 2 格
    //     ('acp' 仍 'system-meta';'tui' 是 'prompt-file-argv':提示档 + 路径指针)。
    //   ⇒ 1 格变 2 格,净 +1。其余单元一个字没动。
    // #6097(2026-09-21)⇒ **-2**,74 → **72**。逐格减出来的,❌ 不是照测试输出改的:
    //   删掉的八家里只有三格 native 单元 —— `openclaw.env` / `letta.env` / `autohand.env`;
    //   其中 openclaw 的 `surfaces` 是空表,被这个循环开头那句 `surfaces.length === 0` 挡在外面,
    //   本来就没进过 checks ⇒ 净减 2 格(letta.env + autohand.env)。其余七家五维全是 none。
    // qwen 2026-09-23(#6192)⇒ 再 **-1**,72 → **71**:mcp 原本按腿 2 格(ACP `acp-session` + 终端
    //   `system-config-overlay`),现在两条腿同走 settings 副本(协议带不动 alwaysLoadTools)⇒ 扁平 1 格。
    // #6335(2026-09-23)antigravity 开出 acp 腿 ⇒ **+3**,71 → **74**:mcp('acp-session')、
    //   env('child-process')、promptBlocks('session-context');model / autonomy 仍 none(理由见该家 descriptor)。
    // #6335(2026-09-24)antigravity 接回终端腿 ⇒ **+1**,74 → **75**(Windows 上终端腿不开,仍 74):
    //   mcp 由扁平 1 格变按腿 2 格('acp-session' + 终端 'config-file');promptBlocks 按腿但终端那格是 none,
    //   不进 checks;env 仍扁平 1 格;model / autonomy 仍 none。
    // #6335(2026-09-24)antigravity 终端腿的 promptBlocks 由 none 变 native('hook-ephemeral':PreInvocation 钩子的
    //   ephemeral 消息,run-scoped 档 + env 指针)⇒ **+1**,75 → **76**(Windows 上终端腿不开,仍 74)。
    // hermes 2026-09-28 acp 的 mcp 由 none 变 native('acp-session';09-02 的「工具进不了模型」是
    //   渐进披露桥被读错,见该家 descriptor)⇒ **+1**,76 → **77**(Windows 74 → 75)。
    //   同日 hermes 撤掉终端腿,五维从按腿改成扁平:mcp / model / promptBlocks 原本各是 acp 1 格,
    //   扁平后仍各 1 格;终端腿本来全 none、一格没进过 ⇒ **+0**。
    // hermes 2026-10-04 改走 serve 桥:model 'config-file' → 'process-config'、promptBlocks
    //   'session-context' → 'developer-instructions' —— 换通道不换格数 ⇒ **+0**。
    // zcode 2026-10-17 接入(#7385):acp 腿 mcp('acp-session')、env('child-process')、model('process-config')、
    //   promptBlocks('session-context')四格 native,autonomy 走 ACP 档位不进 checks ⇒ **+4**,77 → **81**(Windows 75 → 79)。
    // codebuddy 2026-10-19 接入(#7525):mcp 按腿 2 格('acp-session' + 终端 'config-file-argv')、env 扁平 1 格、
    //   model 扁平 1 格('config-file')、promptBlocks 按腿 2 格('session-context' + 'argv-append');autonomy 走档位表
    //   不进 checks ⇒ **+6**,81 → **87**(Windows 79 → 85)。
    expect(checks).toHaveLength(ANTIGRAVITY_SESSION_TUI_ENABLED ? 87 : 85);
    for (const check of checks) {
      expect(check.populated, check.label + ': ' + JSON.stringify(check.surfaces)).toBe(true);
    }
    vi.unstubAllEnvs();
  });

  /**
   * 「厂商压根不开放」的格子 —— 一格一条,每条都得说得出**为什么**。
   *
   * 这些格子与「还没查」(`unverified`)长得像但意思相反:查过了,结论是终局。
   * 用 `unsupported-channel` 是有举证门槛的(#3889 红线:本仓 grep 不到只能证明咕咕没接)。
   *
   * · kiro.model —— 它不说 OpenAI 协议:推理走 AWS CodeWhisperer RPC
   *   (`x-amz-target: AmazonCodeWhispererStreamingService.*`),981MB 二进制里 `/v1/*` 0 命中
   *   (带阳性对照),settings 白名单已移除 endpoint 覆盖。实测 Kiro CLI 2.19.1。
   */
  const VENDOR_CLOSED_SLOTS: Record<string, readonly string[]> = {
    kiro: ['model'],
  };

  /**
   * 声明的**通道**与物化自报的**载体**必须一致。
   *
   * 为什么要单独一条:上面那条只问「这一格填了没有」,不问「填进去的那根管子对这家通不通」。
   * 两者的差别不是理论 —— 2026-08-27 之前,四家(auggie / oh-my-pi / qoder / qwen)声明着
   * `first-turn-hidden-context`,物化器也**确实**填了 `prompt`,于是上面那条一路绿;而那条通道
   * 的终点是 `_meta.systemPrompt.append` —— 咕咕**自己的**约定,不是 ACP 协议字段,厂商原生的
   * ACP server 收下即丢(同形的 copilot 实测 0/6)。⇒ 「声明送到了、判据也绿了、实际一个字没送」。
   *
   * 这条判据把那个缺口补上:`session-context` 这条通道的兑现,不只是 `prompt` 非空,
   * 还必须自报 `carrier: 'session-context'` —— 缺席会静默回落系统位,也就是回到那个黑洞。
   */
  it('声明 session-context 的家，物化必须自报同名载体', () => {
    const checked: string[] = [];
    for (const provider of pluginRegistry.getAll()) {
      const descriptor = provider.capabilities.sessionBundle;
      const behavior = provider.behavior.sessionBundle;
      if (!behavior) continue;
      for (const surface of descriptor.surfaces) {
        const leaf = resolveUnitDelivery(descriptor.units.promptBlocks, surface);
        if (leaf.kind !== 'native') continue;
        const materialized = behavior.materialize(
          { surface, lifecycle: 'fresh', cwd: NATIVE_CHANNEL_CWD },
          channelProbeBundle(provider.metadata.id, 'promptBlocks', true, probeModelDialects[0]),
        );
        const label = `${provider.metadata.id}@${surface}`;
        if (leaf.channel === 'session-context') {
          expect(materialized.prompt?.carrier, `${label}: 声明 session-context 却没自报载体`)
            .toBe('session-context');
          checked.push(label);
        } else if (materialized.prompt) {
          // 反向:走系统位的家❌ 不许自报 session-context —— 那会把它的块从系统位挪走。
          expect(materialized.prompt.carrier ?? 'system', `${label}: ${leaf.channel} 不该自报 session-context`)
            .not.toBe('session-context');
        }
      }
    }
    // 反空转:表空了的话上面那个循环对空集为真。
    expect(checked.length, '没有任何一家声明 session-context —— 这条判据在空转').toBeGreaterThan(0);
  });

  it('vendor-closed 登记表本身是活的（防空转）', () => {
    // 表空了的话，上面那条「逐格替换」就退化成原来的全默认断言，而读代码的人
    // 会以为终局态仍在被检查。
    const entries = Object.entries(VENDOR_CLOSED_SLOTS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, slotNames] of entries) {
      expect(pluginRegistry.get(id), `${id}: 登记了却不在注册表里`).toBeDefined();
      expect(slotNames.length, `${id}: 登记了空清单`).toBeGreaterThan(0);
    }
  });

  it('keeps every remaining unmigrated S0 delivery unit explicit and unverified', () => {
    let remaining = 0;
    for (const provider of pluginRegistry.getAll()) {
      if (
        // #6335:antigravity 迁出 —— 官方 ACP 服务那条腿五维逐格实测声明(impl/antigravity/session-bundle.ts)。
        provider.metadata.id === 'antigravity' ||
        provider.metadata.id === 'claude' ||
        provider.metadata.id === 'codex' ||
        provider.metadata.id === 'copilot' ||
        provider.metadata.id === 'cursor' ||
        provider.metadata.id === 'gemini' ||
        provider.metadata.id === 'grok' ||
        provider.metadata.id === 'hermes' ||
        provider.metadata.id === 'kimi' ||
        provider.metadata.id === 'oh-my-pi' ||
        provider.metadata.id === 'opencode' ||
        provider.metadata.id === 'pi' ||
        provider.metadata.id === 'auggie' ||
        provider.metadata.id === 'commandcode' ||
        provider.metadata.id === 'continue' ||
        provider.metadata.id === 'mimocode' ||
        provider.metadata.id === 'qoder' ||
        provider.metadata.id === 'qwen' ||
        // #7385:zcode 只开 ACP 腿,五维逐格实测声明(impl/zcode/session-bundle.ts 抬头)。
        provider.metadata.id === 'zcode' ||
        // #7525:codebuddy 两条腿五维逐格实测声明(impl/codebuddy/session-bundle.ts 抬头)。
        provider.metadata.id === 'codebuddy'
      ) continue;
      remaining += 1;
      const { units, extension } = provider.capabilities.sessionBundle;
      const slots = ['mcp', 'env', 'model', 'autonomy', 'promptBlocks', 'extension'] as const;
      const actual = [units.mcp, units.env, units.model, units.autonomy, units.promptBlocks, extension];
      // ⚠️ 这一格**不是**「还没查」,不能用上面那个默认值 —— 见 VENDOR_CLOSED_SLOTS 抬头。
      // ❌ 别图省事把整家塞进上面那张豁免名单:那会连它另外 5 格一起停止检查,
      //    等于拿豁免换绿灯。这里逐格替换,其余 5 格照旧严格。
      const closedSlots = VENDOR_CLOSED_SLOTS[provider.metadata.id] ?? [];
      expect(actual, provider.metadata.id).toEqual(
        slots.map((slot) =>
          closedSlots.includes(slot)
            ? { kind: 'none', degraded: { code: 'unsupported-channel', reason: expect.any(String) } }
            : {
                kind: 'none',
                degraded: {
                  code: 'unverified',
                  reason: 'Session bundle delivery has not been verified for this adapter.',
                },
              }
        )
      );
      expect(provider.behavior.sessionBundle, provider.metadata.id).toBeDefined();
    }
    // **棘轮 + 防空转**,不是精确值。
    //
    // 上界:迁一家就该变小,❌ 不许变长(变长 = 有人往回退,或新加了一家没接的适配器却没人注意)。
    // 下界:全迁完之前这个循环不能是空的 —— 否则上面那一整套逐格比对是在对空集求值,
    //      无论闸在不在都全绿。
    //
    // ⚠️ 取 `<=` 而不是 `===`,是因为这个文件是**磁铁**:几家并行迁移时,精确值会让每条 PR
    //    都堵在这一行上互相冲突,而冲突的解法通常是「把数字改成自己那版」—— 那等于谁最后合谁说了算。
    // 2026-09-01 grok 迁出(#4658,ACP 腿五维声明)⇒ 19 → 18。
    // 2026-09-23 antigravity 迁出(#6335)⇒ 上界 18 → 17。
    expect(remaining, '未迁移的家数').toBeLessThanOrEqual(17);
    expect(remaining, '一家都没有 = 上面的逐格比对在对空集求值').toBeGreaterThan(0);
  });

  it('declares Pi from its 0.85.1 extension API reading', () => {
    const provider = pluginRegistry.get('pi')!;
    const { units, extension } = provider.capabilities.sessionBundle;

    expect(units.mcp).toEqual({ kind: 'native', channel: 'extension-event' });
    expect(units.promptBlocks).toEqual({ kind: 'native', channel: 'extension-event' });
    expect(extension).toEqual({
      kind: 'event-module',
      format: 'pi',
      scope: 'workspace',
      carries: { mcp: 'none', skills: 'none', systemPrompt: 'module', hooks: 'module' },
    });
  });

  it('declares Codex delivery through the R1/R2 verified declarative bundle', () => {
    const provider = pluginRegistry.get('codex')!;
    const { units, extension } = provider.capabilities.sessionBundle;

    expect([units.mcp, units.env, units.model, units.autonomy, units.promptBlocks]).toEqual([
      { kind: 'native', channel: 'process-config' },
      { kind: 'native', channel: 'child-process' },
      { kind: 'native', channel: 'process-config' },
      { kind: 'native', channel: 'process-config' },
      { kind: 'native', channel: 'developer-instructions' },
    ]);
    expect(extension).toEqual({
      kind: 'declarative-bundle',
      format: 'codex',
      activation: 'skill-roots',
      carries: { mcp: 'none', skills: 'manifest', hooks: 'none' },
    });
    expect(provider.behavior.sessionBundle).toBeDefined();
  });

  it('declares OpenCode as an event module with process-config delivery', () => {
    const provider = pluginRegistry.get('opencode')!;
    const { units, extension } = provider.capabilities.sessionBundle;

    expect([units.mcp, units.env, units.model, units.autonomy, units.promptBlocks]).toEqual([
      { kind: 'native', channel: 'process-config' },
      { kind: 'native', channel: 'child-process' },
      { kind: 'native', channel: 'process-config' },
      // autonomy —— 2026-08-25 起是 native：`OPENCODE_CONFIG_CONTENT` 里的 `permission` 块，
      // 与 mcp/model/promptBlocks 同一条 process-config 通道。
      { kind: 'native', channel: 'process-config' },
      { kind: 'native', channel: 'process-config' },
    ]);
    expect(extension).toEqual({
      kind: 'event-module',
      format: 'opencode',
      scope: 'workspace',
      carries: { mcp: 'none', skills: 'none', systemPrompt: 'none', hooks: 'module' },
    });
  });

  it('declares MiMo Code as an OpenCode-family serve/attach adapter without workspace plugin delivery', () => {
    const provider = pluginRegistry.get('mimocode')!;
    const { sessionpage, extension } = provider.capabilities.sessionBundle;
    expect(sessionpage['tui']).toMatchObject({
      identity: 'addressable',
      messageTransport: 'router',
      hostAdapter: 'opencode-serve-attach-v1',
    });
    expect(extension).toMatchObject({
      kind: 'none',
      degraded: { code: 'upstream-broken' },
    });
    expect(provider.capabilities.sessionBundle.runtimeCompatibility?.['tui']).toEqual({
      kind: 'semver-supported-floor',
      supportedFloor: '0.1.13',
      versionArgs: ['--version'],
    });
  });

  // #6182 (2026-09-22 measured): pi-acp reports `model` and `set_config_option` reaches pi `set_model` with a
  // read-back. `reload-session` cannot work for pi: a resumed pi session goes back to the model in its session file.
  it('switches the Pi model live with a read-back, never through a session reload', () => {
    expect(pluginRegistry.get('pi')!.capabilities.acp.liveSettings?.model).toMatchObject({
      channel: 'acp-config-option',
      ack: 'ack-read-back',
      reloadRequired: false,
    });
  });

  // #6211: the model-catalog probe points the Pi ACP leg at the root the descriptor declares. The live
  // session must be handed that same root, or the "your own model" tier lists what the session never reads.
  it('hands the Pi ACP session the config root its descriptor declares', () => {
    const provider = pluginRegistry.get('pi')!;
    const root = provider.capabilities.sessionBundle.acpConfigRoot!;
    const bundle = channelProbeBundle('pi', 'env', false);
    const materialized = provider.behavior.sessionBundle!.materialize(
      { surface: 'acp', lifecycle: 'fresh', cwd: NATIVE_CHANNEL_CWD },
      bundle,
    );
    expect(materialized.env[root.envVar]).toBe(join(bundle.env.GUGU_HOME!, ...root.guguHomePath));
  });

  // The renderer wires `reload-session` only for the model dimension (planModelSwitch); any other dimension
  // declaring it would reach reportUnwiredRestart and fail loud at the user.
  it('declares reload-session only on the model dimension', () => {
    for (const plugin of pluginRegistry.getAll()) {
      const live = plugin.capabilities.acp.liveSettings;
      if (!live) continue;
      for (const [dimension, setting] of Object.entries(live)) {
        if (dimension === 'model') continue;
        expect({ plugin: plugin.metadata.id, dimension, channel: (setting as { channel?: string } | undefined)?.channel })
          .not.toMatchObject({ channel: 'reload-session' });
      }
    }
  });

  it('gates the Codex session-page TUI leg on 0.153.0 and the chat leg on 0.136.0 (#6341, #6387)', () => {
    const compat = pluginRegistry.get('codex')!.capabilities.sessionBundle.runtimeCompatibility;
    // #6294 的「TUI 建 thread、咕咕认领」:0.149.0 起未落盘 thread 才能 section/move,0.153.0 起 thread/read 才带 model。
    expect(compat?.['app-server']).toEqual({
      kind: 'semver-supported-floor',
      supportedFloor: '0.153.0',
      versionArgs: ['--version'],
    });
    // #6387 app-server `skills/extraRoots/set` (installed Apps' skills as codex's own) is there from 0.136.0 on.
    expect(compat?.['acp']).toMatchObject({ supportedFloor: '0.136.0' });
  });

  // #6953 (2026-10-06 measured, qwen 0.24.4): `set_config_option mode` reads the mode back and takes effect inside the
  // running turn ⇒ busy reject. Without this dimension a qwen Work session opened only in full access — on qwen's own
  // `auto`, which the mode table leaves out — and every stricter tier failed to start.
  it('declares the qwen permission dimension on the measured config channel (#6953)', () => {
    expect(pluginRegistry.get('qwen')!.capabilities.acp.liveSettings).toEqual({
      model: { channel: 'reload-session', ack: 'none', busy: 'reject', reloadRequired: true, recovery: 'runtime-restart' },
      permission: {
        channel: 'acp-config-option',
        ack: 'ack-read-back',
        busy: 'reject',
        reloadRequired: false,
        recovery: 'none',
        allowStartupDowngrade: true,
      },
    });
  });

  it('declares MiMo ACP startup settings only on measured config channels', () => {
    const liveSettings = pluginRegistry.get('mimocode')!.capabilities.acp.liveSettings;
    expect(liveSettings).toEqual({
      model: {
        channel: 'acp-config-option',
        ack: 'ack-read-back',
        busy: 'reject',
        reloadRequired: false,
        recovery: 'none',
      },
      permission: {
        channel: 'acp-config-option',
        ack: 'ack-read-back',
        busy: 'reject',
        reloadRequired: false,
        recovery: 'none',
        allowStartupDowngrade: true,
      },
      effort: {
        channel: 'unsupported',
        ack: 'none',
        busy: 'reject',
        reloadRequired: false,
        recovery: 'unsupported',
      },
    });
  });

  it('declares Claude delivery through its verified session adapter', () => {
    const provider = pluginRegistry.get('claude')!;
    const { units, extension } = provider.capabilities.sessionBundle;

    expect([units.mcp, units.env, units.model].map((unit) => unit.kind)).toEqual([
      'native',
      'native',
      'native',
    ]);
    // 系统提示两条腿同坐系统位、运输不同:协议腿走 `_meta`,终端腿走提示档 + 路径(#5852)。
    expect(units.promptBlocks).toEqual({
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'system-meta' },
        'tui': { kind: 'native', channel: 'prompt-file-argv' },
      },
    });
    expect(units.autonomy).toMatchObject({
      kind: 'none',
      degraded: { code: 'unsupported-channel' },
    });
    expect(extension).toMatchObject({
      kind: 'declarative-bundle',
      format: 'claude',
      activation: 'session-dir',
    });
    expect(provider.behavior.sessionBundle).toBeDefined();
  });

  it('fails loud on a duplicate adapter id', () => {
    const provider = pluginRegistry.get('codex')!;

    expect(() => createAgentPluginRegistry([provider, provider])).toThrow(
      "Duplicate agent plugin id 'codex'"
    );
  });

  it('fails loud when a surfaced adapter has no materializer', () => {
    const provider = pluginRegistry.get('codex')!;
    const invalid = {
      ...provider,
      behavior: { ...provider.behavior, sessionBundle: undefined },
    } as typeof provider;

    expect(() => createAgentPluginRegistry([invalid])).toThrow(
      "Agent plugin 'codex' declares session bundle surfaces without a materializer"
    );
  });

  it('fails loud when a complete mode table has nothing at least as strict as the selected level (#6221)', () => {
    const provider = pluginRegistry.get('qwen')!;
    const onlyFullAccess = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        autoApprove: { kind: 'supported', modes: { 'full-access': { id: 'yolo' } }, modesExhaustive: true },
      },
    } as typeof provider;
    const registry = createAgentPluginRegistry([onlyFullAccess]);
    const build = (permissionMode: 'edit' | 'full-access') => registry.get('qwen')!.behavior.prompt!.buildCommand({
      cli: '/bin/qwen',
      permissionMode,
      model: '',
    });

    expect(() => build('edit')).toThrow(/permission mode 'edit' is not declared and no declared mode is at least as strict/);
    expect(build('full-access').args).toContain('--approval-mode=yolo');
  });

  it('delivers the own-model pick on the pi terminal leg (#6246)', () => {
    const args = pluginRegistry.get('pi')!.behavior.prompt!.buildCommand({
      cli: '/bin/pi', initialPrompt: 'hi', cliSessionId: 's', isResuming: false,
      model: 'mine/own-a', effort: '',
    }).args;
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'mine/own-a']);
    // [control] no pick ⇒ no flag: pi keeps its own default (the bytes snapshot below pins this).
    expect(pluginRegistry.get('pi')!.behavior.prompt!.buildCommand({
      cli: '/bin/pi', initialPrompt: 'hi', cliSessionId: 's', isResuming: false,
      model: '', effort: '',
    }).args).not.toContain('--model');
  });

  it('keeps all provider command construction bytes unchanged', () => {
    const commands = pluginRegistry.getAll()
      .filter((provider) => provider.behavior.prompt)
      .map((provider) => ({
      id: provider.metadata.id,
      command: provider.behavior.prompt?.buildCommand({
        cli: '/bin/provider',
        permissionMode: 'edit',
        initialPrompt: 'foundation prompt',
        cliSessionId: 'snapshot-session',
        isResuming: false,
        model: '',
        effort: '',
      }),
    }));
    const bytes = JSON.stringify(commands);

    // #4655:gemini 首次进入这份快照(此前它没有 prompt 行为)。新增的那一条是
    // `{"id":"gemini","command":{"command":"/bin/provider","args":["-i","foundation prompt"],"env":{}}}`
    // —— 其余各家的字节一个没变(3812 + 97 = 3909)。
    // 2026-09-10 钩子协议改名(EMDASH_* → GUGU_*):codex 的 notify 命令里变量名与请求头、kiro 的 `--agent emdash`、
    // oh-my-pi 的扩展路径 `emdash-hook.ts` 三处变短,3909 → 3887。
    // #5877 曾把 codex 的 `-c check_for_update_on_startup=false` 写进 buildCommand(3928);#6186 把它挪成
    // descriptor 的 `selfUpdate` 声明、由宿主追加,buildCommand 的字节回到 3887,与 #5877 之前逐字节一致。
    // #6097(2026-09-21):八家插件被删,这份快照少了 **7** 条记录 —— openclaw 的 `prompt` 是
    // `{ kind: 'none' }`,上面那句 `.filter(provider.behavior.prompt)` 从来就没把它收进来。
    // 7 条合计 624 字节。⚠️ 留下的各家字节**一个没变**:这份快照的用途就是
    // 「别人的 argv 不许被顺带改动」,所以核的是长度差等于被删那几条的长度,❌ 不是把测试
    // 输出抄进来。
    // #6221:档位表完整的两家不再裸跑 —— 这份快照不选档(旧布尔 false ⇒ edit),qwen 多出
    // `"--approval-mode=default",`(+26)、cursor 多出 `"--mode","ask",`(+15)。
    // 合起来:3887(上面 #6186 那段)− 624 + 41 = 3304,由各自的增删独立算出;哈希算不出来,只能在 mac1 上量。
    // #6335(2026-09-23):antigravity 的终端腿退役、`prompt` 改为 `{ kind: 'none' }`,它那一条
    // `{"id":"antigravity","command":{"command":"/bin/provider","args":["--conversation=snapshot-session","-i","foundation prompt"],"env":{}}}`
    // (135 字节 + 1 个逗号)退出快照,再 −136。
    // #6335(2026-09-24):终端腿接回,antigravity 重新进快照 —— 那一条是
    // `/bin/sh -c <ANTIGRAVITY_LAUNCH_SCRIPT> /bin/provider -i "foundation prompt"`,619 字节 + 1 个逗号 ⇒ +620。
    // 别家字节一个没变(3168 + 620 = 3788,MBP 量)。
    // #6335 第三层(2026-09-24):启动器多了三行 —— 影子 home 里放 `Library/Keychains` → 真 home 的软链
    // (`security` 找钥匙串跟着 HOME 走,理由见 `ANTIGRAVITY_LAUNCH_SCRIPT`),antigravity 那一条 619 → 856,
    // +237。别家那 3168 字节 MBP 实测一个没变(去掉 antigravity 后序列化长度仍是 3168)。
    // #7366(2026-10-17):不选档的旧布尔 false 不再「一个旗标都不加」,而是按编辑档显式推 ⇒ claude 多
    // `"--permission-mode","acceptEdits",`(+34)、gemini 多 `"--approval-mode=auto_edit",`(+28)、
    // antigravity 多 `"--mode","accept-edits",`(+24),合计 +86;别家字节一个没变。
    // #7525(2026-10-19):codebuddy 首次进入快照,新增一条(含逗号)+163 ——
    // `{"id":"codebuddy","command":{"command":"/bin/provider","args":["--session-id","snapshot-session","--permission-mode","acceptEdits","foundation prompt"],"env":{}}}`;
    // 别家字节一个没变(mac1 量:去掉这一条后长度 4111、哈希仍是 09c624df…fa913)。
    expect(bytes).toHaveLength(3304 - 136 + 620 + 237 + 86 + 163);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '7e40477cda2ef89f0f69ffbf7f1105b1d4b90c4f86470347ca363d99501fcff1'
    );
  });

  it('matches the observed pre-migration fresh Claude TUI argv shape', () => {
    const command = pluginRegistry.get('claude')!.behavior.prompt!.buildCommand({
      cli: '/bin/claude',
      permissionMode: 'full-access',
      initialPrompt: 'N3 first turn',
      cliSessionId: 'n3-fresh-session',
      isResuming: false,
      model: 'glm-5.2',
      effort: '',
    });

    expect(command).toEqual({
      command: '/bin/claude',
      args: [
        '--session-id',
        'n3-fresh-session',
        '--dangerously-skip-permissions',
        '--model',
        'glm-5.2',
        'N3 first turn',
      ],
      env: {},
      // argv 上真的有 auto-approve flag(spec hook-status-derivation 的事实源)。
      autoApproved: true,
    });
  });

  it('delivers Claude UltraCode through session settings instead of an effort enum', () => {
    const buildCommand = pluginRegistry.get('claude')!.behavior.prompt!.buildCommand;
    const base = {
      cli: '/bin/claude',
      permissionMode: 'edit' as const,
      initialPrompt: undefined,
      cliSessionId: 'claude-ultracode',
      isResuming: false,
      model: 'sonnet',
    };

    const ultracode = buildCommand({ ...base, effort: 'ultracode' });
    expect(ultracode.args).toContain('--settings');
    expect(ultracode.args).toContain('{"ultracode":true}');
    expect(ultracode.args).not.toContain('--effort');

    const high = buildCommand({ ...base, effort: 'high' });
    expect(high.args).toContain('--effort');
    expect(high.args).toContain('high');
    expect(high.args).not.toContain('{"ultracode":true}');
  });

  it('each entry has required string fields', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(typeof d.metadata.id).toBe('string');
      expect(d.metadata.id.length).toBeGreaterThan(0);
      expect(typeof d.metadata.name).toBe('string');
      expect(typeof d.metadata.description).toBe('string');
      expect(typeof d.metadata.websiteUrl).toBe('string');
    }
  });

  it('each entry passes validate() with no errors', () => {
    for (const d of pluginRegistry.getAll()) {
      const errors = d.validate();
      expect(errors, `${d.metadata.id} validate() errors: ${JSON.stringify(errors)}`).toHaveLength(
        0,
      );
    }
  });

  it('capabilities contain no function values at top level', () => {
    for (const d of pluginRegistry.getAll()) {
      for (const v of Object.values(d.capabilities as Record<string, unknown>)) {
        expect(typeof v).not.toBe('function');
      }
    }
  });

  it('each entry has required capabilities', () => {
    for (const d of pluginRegistry.getAll()) {
      const { capabilities } = d;
      expect(capabilities.hostDependency).toBeDefined();
      expect(capabilities.auth).toBeDefined();
      expect(capabilities.hooks).toBeDefined();
      expect(capabilities.mcp).toBeDefined();
      expect(capabilities.plugins).toBeDefined();
      expect(['supported', 'none']).toContain(capabilities.acp.kind);
      expect(['supported', 'none']).toContain(capabilities.autoApprove.kind);
      expect(['resumable', 'stateless']).toContain(capabilities.sessions.kind);
    }
  });

  it('uses supported CLI login commands for providers with explicit auth commands', () => {
    const claude = pluginRegistry.get('claude')!;
    expect(cliLoginArgs(claude, 'claude-login')).toEqual(['auth', 'login']);

    const codex = pluginRegistry.get('codex')!;
    expect(cliLoginArgs(codex, 'codex-login')).toEqual(['login']);

    const opencode = pluginRegistry.get('opencode')!;
    expect(cliLoginArgs(opencode, 'opencode-login')).toEqual(['auth', 'login']);

    // kimi / qoder —— owner 2026-08-26 实测「说了需要登录、却没把人带到能登录的地方」的两家。
    // 出处逐条写在各自的 auth.ts 抬头（kimi:MoonshotAI/kimi-code@b17bd61 的
    // `apps/kimi-code/src/cli/sub/login.ts:13-25`;qoder:发行包 @qoder-ai/qodercli@1.1.31 的
    // bundle 里 `new xn("login")` + 官方 cli-reference.md:137）。
    // ⚠️ 这条断言不是装饰:少了声明**就真的没有登录入口**了(spec: harness-auth-surface,
    //    owner 2026-09-19 令删伪造兜底——起一个光秃秃的 CLI 让用户自己猜 `/login` 不是
    //    「带人去登录」)。要给哪家登录 UI,就在那家的 descriptor 里声明带真 argv 的方法。
    const kimi = pluginRegistry.get('kimi')!;
    expect(cliLoginArgs(kimi, 'kimi-login')).toEqual(['login']);

    const qoder = pluginRegistry.get('qoder')!;
    expect(cliLoginArgs(qoder, 'qoder-login')).toEqual(['login']);

    // mimocode(#6100)—— opencode 的逐字节 fork,登录子命令同形。本机 mimo 0.1.13
    // `mimo auth --help` 逐字:`mimo auth login [url]  log in to a provider`。
    // 从前它是「有 behavior 没 descriptor」:checkStatus 登记着却永远跑不到
    // (`checkAuthStatusUncached` 见 auth.kind==='none' 直接答 unknown)。
    const mimocode = pluginRegistry.get('mimocode')!;
    expect(cliLoginArgs(mimocode, 'mimocode-login')).toEqual(['auth', 'login']);
  });

  /**
   * 「产品内能登录的是哪几家」—— 这张名单就是用户面的真值:抽屉的「账号」行、composer 的
   * 「登录以使用 X 模型」、会话末行的「去登录」,三处共用 `resolveSignInMethod`(认 cli-login 与 acp-authenticate)。
   *
   * ⚠️ 声明 `auth` 却**一条 cli-login 都没有**是不允许的(#6100):`buildLoginCommand` 只接
   *    cli-login,咕咕也没有填 api-key 的界面 —— 那种声明换不来任何可点的东西,只会让下一个人
   *    以为这家能在产品里登录(gemini / qwen 从前就是这形状)。平台额度怎么送进去,记在
   *    这一家的 `platform.ts`,❌ 不是这里。
   */
  /**
   * #6264「在别的机器上登录」—— 只给声明了不靠回跳的登录方式的家,每一条都有厂商出处(写在各家 descriptor 旁)。
   * 名单外的(qoder / mimocode)在远程时如实说明「到那台机器的终端里自己登」。
   */
  it('能从别的电脑替它登录的家 = 声明了 headlessArgs 的家,参数逐字', () => {
    const headless = Object.fromEntries(
      pluginRegistry.getAll().flatMap((provider) => {
        if (provider.capabilities.auth.kind !== 'supported') return [];
        const method = provider.capabilities.auth.methods.find((m) => m.kind === 'cli-login');
        return method?.kind === 'cli-login' && method.headlessArgs ? [[provider.metadata.id, method.headlessArgs]] : [];
      })
    );
    expect(headless).toEqual({
      claude: ['auth', 'login'],
      codex: ['login', '--device-auth'],
      kimi: ['login'],
      opencode: ['auth', 'login'],
    });
  });

  it('在产品内能发起登录的家 = 声明了 cli-login 或 acp-authenticate 的家,且没有一家只声明 api-key', () => {
    const declared = pluginRegistry
      .getAll()
      .filter((provider) => provider.capabilities.auth.kind === 'supported');
    const withRunnableLogin = declared.filter((provider) =>
      provider.capabilities.auth.kind === 'supported'
      && provider.capabilities.auth.methods.some(
        (method) => method.kind === 'cli-login' || method.kind === 'acp-authenticate'
      )
    );
    expect(withRunnableLogin.map((provider) => provider.metadata.id).sort()).toEqual([
      // #6335:antigravity 没有登录子命令,走协议登录(ACP `authenticate`)。
      'antigravity',
      'claude',
      // #7525:codebuddy 也没有登录子命令,走协议登录(ACP `authenticate`,国际版 / 中国版两条)。
      'codebuddy',
      'codex',
      'kimi',
      'mimocode',
      'opencode',
      'qoder',
    ]);
    // 阳控同时是判据:声明了 auth 的家必须**全部**在上面那张名单里。
    expect(declared.map((provider) => provider.metadata.id).sort()).toEqual(
      withRunnableLogin.map((provider) => provider.metadata.id).sort()
    );
  });

  /**
   * 「有行为没声明」的反面判据(#6100)。`checkAuthStatusUncached` 的闸是
   * `provider.auth.kind === 'none' ⇒ ok({kind:'unknown'})` —— 所以一个登记了 `behavior.auth`
   * 而 descriptor 仍是 `none` 的家,它那份 checkStatus **一次都跑不到**:代码在、读数永远是 unknown,
   * 而且长得和「这家判不出登录态」一模一样。
   */
  it('登记了 auth 行为的家必须也声明了 auth —— ❌ 不留读不到的判据', () => {
    const withBehavior = pluginRegistry
      .getAll()
      .filter((provider) => provider.behavior.auth?.checkStatus)
      .map((provider) => provider.metadata.id);
    // 阳控:这把尺子先得量得到东西。`behavior.auth` 要是拼错或投影里没有,下面的
    // `toEqual([])` 会**永远**绿 —— 那不是控,是第二次同样的空读数。
    expect(withBehavior).toContain('claude');
    expect(withBehavior).toContain('mimocode');

    const orphans = pluginRegistry
      .getAll()
      .filter(
        (provider) => provider.behavior.auth?.checkStatus && provider.capabilities.auth.kind === 'none'
      )
      .map((provider) => provider.metadata.id);
    expect(orphans).toEqual([]);
  });

  // #6798、#7035:哪几家的终端提问能从提问卡回答,只看声明里的取消键。
  it('声明 sessionTuiQuestionAnswer 的家都带着取消键', () => {
    const declared = pluginRegistry
      .getAll()
      .filter((provider) => provider.capabilities.sessionBundle.sessionTuiQuestionAnswer)
      .map((provider) => [provider.metadata.id, provider.capabilities.sessionBundle.sessionTuiQuestionAnswer?.cancel])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    // 阳控:字段被 zod 剥掉时这里是空表,写成「每一家都带键」照样绿。
    expect(declared).toEqual([['claude', '\u001b'], ['codex', '\u001b'], ['opencode', '\u001b']]);
  });

  it('fails loudly for every resumable harness without a verified fork adapter', () => {
    // These are documentation/adapter gaps, not claims that the products
    // categorically lack fork. Keep the runtime fail-loud until an adapter is
    // backed by an official startup contract and an exact argv test.
    const unverifiedForkAdapters = [
      'amp',
      'auggie',
      'commandcode',
      'continue',
      'copilot',
      'cursor',
      'devin',
      // Context7 documents `droid exec --fork <id>` only as a non-interactive
      // prompt run. It does not establish Gugu's zero-input interactive lifecycle.
      'droid',
      // gemini 0.57.0: no fork surface — neither `--help` nor the bundled
      // session-management docs expose one (resume takes uuid/index/latest only).
      'gemini',
      'grok',
      // No Hermes-native startup fork contract was found. The prior
      // `--fork-session` hit belongs to Hermes' bundled Grok CLI guide.
      'hermes',
      'junie',
      // Local session fork is an HTTP `POST /session { parentID }`; the CLI
      // `--fork` documentation takes a SHARE_ID, not a local session id.
      'kilocode',
      'kimi',
      'kiro',
      'mimocode',
      'qoder',
      'qwen',
      // 桥(@gugu-acp/zcode-acp)报了 sessionCapabilities.fork,但咕咕这条 ACP 腿的 fork 没量过(#7385)。
      'zcode',
      // CLI 有 `--fork-session`,但咕咕两条腿的 fork 都没量过(#7525)。
      'codebuddy',
    ] as const;
    const verifiedForkAdapters = [
      // agy_acp_server 的 `session/fork` 是空桩;分叉由宿主在它的存档上做(./antigravity/fork.ts,#6335)。
      'antigravity',
      'claude',
      'codex',
      'oh-my-pi',
      'opencode',
      'pi',
    ] as const;
    const unresolvedForkAdapters = [] as const;
    const resumableHarnesses = pluginRegistry
      .getAll()
      .filter((provider) => provider.capabilities.sessions.kind === 'resumable')
      .map((provider) => provider.metadata.id)
      .sort();

    expect(
      [
        ...verifiedForkAdapters,
        ...unresolvedForkAdapters,
        ...unverifiedForkAdapters,
      ].sort(),
    ).toEqual(resumableHarnesses);

    expect(
      pluginRegistry.get('antigravity')!.behavior.acp?.forkSessionInStorage,
      'antigravity forks through its storage adapter',
    ).toBeTypeOf('function');

    for (const id of unresolvedForkAdapters) {
      const provider = pluginRegistry.get(id)!;
      expect(provider.capabilities.sessions.fork, `${id} must remain unresolved`).not.toBe(
        'supported',
      );
      // #4406 起 opencode 有 tui 腿,fork 仍 unresolved —— 走到 fork 的 buildCommand
      // 由下面的断言钉住:照样响亮拒绝,❌ 不因有腿而静默放行。
      expect(() =>
        provider.behavior.prompt!.buildCommand({
          cli: id,
          permissionMode: 'edit',
          cliSessionId: 'new-session',
          forkFromProviderSessionId: `source-${id}`,
          isResuming: false,
          model: '',
        }),
      ).toThrow(/no verified fork adapter is configured/);
    }

    for (const id of unverifiedForkAdapters) {
      const provider = pluginRegistry.get(id)!;
      expect(provider.capabilities.sessions.fork, `${id} must remain unverified`).not.toBe(
        'supported',
      );
      // 只有 ACP 腿的家(antigravity,#6335)根本没有 argv 这条路 —— 没有命令可以带着 fork 被拼出来,
      // 于是「拼的时候响亮失败」这一条对它无从谈起;钉住它确实没有 prompt 行为即可。
      if (!provider.behavior.prompt) {
        expect(provider.capabilities.prompt.kind, `${id} has no command path`).toBe('none');
        continue;
      }
      expect(() =>
        provider.behavior.prompt!.buildCommand({
          cli: id,
          permissionMode: 'edit',
          cliSessionId: 'new-session',
          forkFromProviderSessionId: `source-${id}`,
          isResuming: false,
          model: '',
        }),
      ).toThrow(/no verified fork adapter is configured/);
    }
  });

  it('builds the two newly supported Context7 PTY startup fork commands', () => {
    const cases = [
      {
        id: 'pi',
        source: '/tmp/pi source.jsonl',
        expected: ['--fork', '/tmp/pi source.jsonl'],
      },
      {
        id: 'oh-my-pi',
        source: '/tmp/omp source.jsonl',
        expected: [
          '--extension',
          './.omp/extensions/gugu-hook.ts',
          '--fork',
          '/tmp/omp source.jsonl',
        ],
      },
    ] as const;

    for (const { id, source, expected } of cases) {
      const provider = pluginRegistry.get(id)!;
      expect(provider.capabilities.sessions.fork, `${id} must expose verified fork`).toBe(
        'supported',
      );
      expect(
        provider.behavior.prompt!.buildCommand({
          cli: id,
          permissionMode: 'edit',
          cliSessionId: 'new-session',
          forkFromProviderSessionId: source,
          isResuming: false,
          model: '',
        }).args,
      ).toEqual(expected);
    }
  });

  it('marks OpenCode fork as host-owned rather than inventing CLI fork argv', () => {
    const provider = pluginRegistry.get('opencode')!;
    expect(provider.capabilities.sessions.fork).toBe('supported');
    const command = provider.behavior.prompt!.buildCommand({
      cli: 'opencode',
      permissionMode: 'edit',
      cliSessionId: 'new-session',
      forkFromProviderSessionId: 'ses_source',
      isResuming: false,
      model: '',
    });
    expect(command.args).not.toContain('--fork');
    expect(command.forkHandledByHost).toBe(true);
  });

  it('each entry has hostDependency.updates with valid kind', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.capabilities.hostDependency.updates).toBeDefined();
      expect(['supported', 'none']).toContain(d.capabilities.hostDependency.updates.kind);
    }
  });

  it('supported updates have valid releaseSource and update strategy', () => {
    for (const d of pluginRegistry.getAll()) {
      if (d.capabilities.hostDependency.updates.kind !== 'supported') continue;
      const { releaseSource, update } = d.capabilities.hostDependency.updates;
      // 'acp-registry':#6335 托管装 ACP 注册表登记的 ACP 服务(antigravity 的 agy_acp_server)。
      expect(['npm', 'github', 'acp-registry', 'none']).toContain(releaseSource.kind);
      expect(['package-manager', 'cli', 'auto', 'none']).toContain(update.kind);
    }
  });

  it('all binaryNames are non-empty strings', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.capabilities.hostDependency.binaryNames.length).toBeGreaterThan(0);
      for (const bin of d.capabilities.hostDependency.binaryNames) {
        expect(typeof bin).toBe('string');
        expect(bin.length).toBeGreaterThan(0);
      }
    }
  });

  it('each defined platform installCommands entry is a non-empty array of valid InstallOptions', () => {
    // ❌ 不在这里抄第二份枚举:抄了就会与 `INSTALL_METHODS` 漂开,而漂开的那一刻这条判据
    //    正好什么都不卡。
    const validMethods: readonly string[] = INSTALL_METHODS;
    for (const d of pluginRegistry.getAll()) {
      const { installCommands } = d.capabilities.hostDependency;
      for (const [platform, options] of Object.entries(installCommands)) {
        expect(Array.isArray(options), `${d.metadata.id}.${platform} should be an array`).toBe(
          true,
        );
        expect(
          options!.length,
          `${d.metadata.id}.${platform} array should be non-empty`,
        ).toBeGreaterThan(0);
        for (const opt of options!) {
          expect(
            typeof opt.command,
            `${d.metadata.id}.${platform} command should be a string`,
          ).toBe('string');
          expect(
            opt.command.length,
            `${d.metadata.id}.${platform} command should be non-empty`,
          ).toBeGreaterThan(0);
          expect(validMethods, `${d.metadata.id}.${platform} method should be valid`).toContain(
            opt.method,
          );
        }
      }
    }
  });

  it('产品内装法只剩托管安装 —— 每一家的 installCommands 要么只有 mise,要么空着', () => {
    // #6098:安装只留「托管安装」+「认你自己装的那份」。npm / Homebrew / curl 脚本 /
    // powershell / winget / 自定义命令的产品内直装全部删除,执行层已经**没有** shell
    // 那条腿 —— 再声明一条那样的装法,界面上就会出现一个按下去必然失败的按钮。
    for (const d of pluginRegistry.getAll()) {
      const { installCommands } = d.capabilities.hostDependency;
      const methods = Object.values(installCommands).flatMap((options) =>
        (options ?? []).map((option) => option.method),
      );
      expect(new Set(methods), `${d.metadata.id} may only install through mise`).toEqual(
        methods.length ? new Set(['mise']) : new Set(),
      );
    }
  });

  it('托管安装的每一格都要有落点 —— 三种后端各有各的必答项', () => {
    // 平台归档:`executables` 至少一格、键形如 `<platform>-<arch>`、值是相对路径。
    // npm 后端:必须钉一个补丁级的 node 版本 —— 装出来的壳是 `#!/usr/bin/env node`,
    //           没有它启动器就发布了一条跑不起来的路(实测 `exec: node: not found`)。
    // ACP 注册表:落点读注册表那一条,这里只卡 agent id 与 `package` 同名、且不带 npm 下载源(#6335)。
    for (const d of pluginRegistry.getAll()) {
      // 伴随程序(#6335)的装法与主程序同一套约束。
      const installCommandSets = [
        d.capabilities.hostDependency.installCommands,
        ...(d.capabilities.hostDependency.companions ?? []).map((c) => c.dependency.installCommands),
      ];
      for (const [platform, options] of installCommandSets.flatMap((set) => Object.entries(set))) {
        for (const option of options ?? []) {
          const target = option.target;
          expect(target?.kind, `${d.metadata.id}.${platform} mise option needs a mise target`).toBe(
            'mise',
          );
          if (target?.kind !== 'mise') continue;
          if (target.backend.kind === 'npm') {
            expect(target.backend.node, `${d.metadata.id} npm backend needs a node pin`).toMatch(
              /^\d+\.\d+\.\d+$/,
            );
            continue;
          }
          if (target.backend.kind === 'acp-registry') {
            expect(target.package, `${d.metadata.id} acp-registry package is the agent id`).toBe(
              target.backend.agentId,
            );
            expect(option.registry, `${d.metadata.id} acp-registry has no npm source`).toBeUndefined();
            continue;
          }
          // 厂商清单:一个 `{platform}` 占位、平台键落在 node 的 `<platform>-<arch>[-musl]` 上、无 npm 下载源。
          if (target.backend.kind === 'vendor-manifest') {
            expect(target.backend.manifest.split('{platform}').length, `${d.metadata.id} manifest placeholder`).toBe(2);
            for (const key of Object.keys(target.backend.platforms)) {
              expect(key, `${d.metadata.id} vendor platform key`).toMatch(/^(darwin|linux|win32)-(x64|arm64)(-musl)?$/);
            }
            expect(option.registry, `${d.metadata.id} vendor-manifest has no npm source`).toBeUndefined();
            continue;
          }
          const executables = Object.entries(target.backend.executables);
          expect(
            executables.length,
            `${d.metadata.id}.${platform} needs at least one platform executable`,
          ).toBeGreaterThan(0);
          for (const [key, relative] of executables) {
            // 键是 `<process.platform>-<process.arch>`,值是归档内的相对路径 ——
            // 绝对路径或 `..` 会在安装时才炸,这里先卡住。
            expect(key, `${d.metadata.id} executables key`).toMatch(
              /^(darwin|linux|win32)-(x64|arm64)$/,
            );
            expect(relative.startsWith('/'), `${d.metadata.id}.${key} must be relative`).toBe(false);
            expect(relative.split(/[\\/]/).includes('..'), `${d.metadata.id}.${key} escapes`).toBe(
              false,
            );
          }
          // 平台包名声明了就必须落在 executables 声明过的那几格上。
          for (const key of Object.keys(target.backend.platformPackages ?? {})) {
            expect(
              target.backend.executables,
              `${d.metadata.id} platformPackages[${key}]`,
            ).toHaveProperty(key);
          }
        }
      }
    }
  });

  it('npm 后端的家共用同一个 node 钉 —— 八家各写一遍必然漂', () => {
    const pins = new Set<string>();
    for (const d of pluginRegistry.getAll()) {
      for (const options of Object.values(d.capabilities.hostDependency.installCommands)) {
        for (const option of options ?? []) {
          const target = option.target;
          if (target?.kind === 'mise' && target.backend.kind === 'npm') pins.add(target.backend.node);
        }
      }
    }
    expect(pins.size, 'every npm-backend family pins the same node').toBeLessThanOrEqual(1);
  });

  it('each entry has an icon asset with at least one variant', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.assets.icon).toBeDefined();
      expect(d.assets.icon.variants.length).toBeGreaterThan(0);
      for (const v of d.assets.icon.variants) {
        expect(typeof v.light).toBe('string');
        expect(v.light.length).toBeGreaterThan(0);
      }
    }
  });

  it('each task prompt provider has a behavior.prompt.buildCommand function', () => {
    for (const p of pluginRegistry.getAll().filter((provider) => provider.capabilities.prompt.kind !== 'none')) {
      expect(typeof p.behavior.prompt?.buildCommand).toBe('function');
    }
  });

  it('passes Grok initial prompts as positional argv for interactive sessions', () => {
    const result = pluginRegistry.get('grok')!.behavior.prompt!.buildCommand({
      cli: 'grok',
      permissionMode: 'full-access',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: '',
    });

    expect(result).toEqual({
      command: 'grok',
      args: ['--always-approve', 'Fix the bug'],
      env: {},
      // argv 上真的有 auto-approve flag(spec hook-status-derivation 的事实源)。
      autoApproved: true,
    });
  });

  it('uses current Grok docs, recognise-only install, and model flag', () => {
    const grok = pluginRegistry.get('grok')!;

    expect(grok.metadata.websiteUrl).toBe('https://docs.x.ai/build/overview');
    expect(grok.capabilities.hostDependency.installDocs).toBe('https://docs.x.ai/build/overview');
    // 只认不装:平台包里是 Brotli 压缩的 `bin/grok.br`,不是可执行文件 —— 咕咕装不了这家。
    expect(grok.capabilities.hostDependency.installCommands).toEqual({});
    expect(grok.capabilities.hostDependency.updates).toEqual({ kind: 'none' });

    const result = grok.behavior.prompt!.buildCommand({
      cli: 'grok',
      permissionMode: 'full-access',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: 'my-model',
    });

    expect(result.args).toEqual(['--always-approve', '-m', 'my-model', 'Fix the bug']);
  });

  it('Antigravity 不再钉静态模型表 —— 模型目录由运行中的 ACP 服务自报;终端腿首句等 gugu MCP 就绪后经 local-session 注入(#6335)', () => {
    const antigravity = pluginRegistry.get('antigravity')!;

    // 旧表钉的「Gemini 3.5 Flash (Medium)」agy 1.2.9 实测 `is not recognized`;ACP 腿的目录来自
    // `session/new` 的 configOptions(harness-model-catalog.ts),静态表只会与之漂移。
    expect(antigravity.capabilities.models).toEqual({ kind: 'none' });
    expect(antigravity.capabilities.prompt).toEqual({ kind: 'argv', flag: '-i', startupDelivery: 'delivery-bridge' });
    expect(typeof antigravity.behavior.prompt?.buildCommand).toBe('function');
  });

  it('Claude 静态表的 id 就是 CLI 自己报的别名,❌ 不是编出来的 API 全名', () => {
    const claude = pluginRegistry.get('claude')!;

    // 与 claude 2.1.229 经 ACP session/new 报的 configOptions 逐字一致(2026-09-15 MBP 实读)。
    expect(claude.capabilities.models).toMatchObject({
      kind: 'selectable',
      defaultModelId: 'default',
      modelOptions: {
        default: { name: 'Default (recommended)' },
        'opus[1m]': { name: 'Opus (1M context)' },
        sonnet: { name: 'Sonnet' },
      },
    });
    expect(Object.keys((claude.capabilities.models as { modelOptions: object }).modelOptions)).not.toContain(
      'claude-opus-4-8'
    );
  });

  it('installs Amp through the managed installer and updates from its npm release', () => {
    const amp = pluginRegistry.get('amp')!;
    const macos = amp.capabilities.hostDependency.installCommands.macos;

    expect(macos?.[0]?.command).toBe('mise install http:gugu-amp');
    expect(macos?.[0]?.target).toMatchObject({
      kind: 'mise',
      package: '@ampcode/cli',
      binary: 'amp',
    });
    // 厂商没发 win32-arm64 平台包 ⇒ 那一格不声明,装的时候会响亮地说不支持。
    const backend = macos?.[0]?.target?.kind === 'mise' ? macos[0].target.backend : undefined;
    expect(backend?.kind === 'platform-archive' && backend.executables).not.toHaveProperty(
      'win32-arm64',
    );
    expect(amp.capabilities.hostDependency.updates).toMatchObject({
      kind: 'supported',
      releaseSource: { kind: 'npm', package: '@ampcode/cli' },
    });
  });

  it('exposes Amp modes as selectable models and passes them with -m', () => {
    const amp = pluginRegistry.get('amp')!;

    expect(amp.capabilities.models).toMatchObject({
      kind: 'selectable',
      modelOptions: {
        low: { name: 'Low' },
        medium: { name: 'Medium' },
        high: { name: 'High' },
        ultra: { name: 'Ultra' },
      },
    });

    const result = amp.behavior.prompt!.buildCommand({
      cli: 'amp',
      permissionMode: 'full-access',
      initialPrompt: '',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: 'ultra',
    });

    expect(result.args).toEqual(['--dangerously-allow-all', '-m', 'ultra']);

    const legacy = amp.behavior.prompt!.buildCommand({
      cli: 'amp',
      permissionMode: 'full-access',
      initialPrompt: '',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: 'deep',
    });

    expect(legacy.args).toEqual(['--dangerously-allow-all', '-m', 'ultra']);
  });

  it('exposes Mistral Vibe models and passes the selected model through env', () => {
    const mistral = pluginRegistry.get('mistral')!;

    expect(mistral.capabilities.models).toMatchObject({
      kind: 'selectable',
      modelOptions: {
        'mistral-medium-3.5': { name: 'Mistral Medium 3.5' },
        'devstral-small': { name: 'Devstral Small' },
        local: { name: 'Local Devstral' },
      },
    });

    const result = mistral.behavior.prompt!.buildCommand({
      cli: 'vibe',
      permissionMode: 'full-access',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: 'mistral-medium-3.5',
    });

    expect(result).toEqual({
      command: 'vibe',
      args: ['--agent', 'auto-approve', 'Fix the bug'],
      env: { VIBE_ACTIVE_MODEL: 'mistral-medium-3.5' },
      // argv 上真的有 auto-approve flag(spec hook-status-derivation 的事实源)。
      autoApproved: true,
    });
  });

  it('resumes Pi with the stored session file instead of the latest session', () => {
    const pi = pluginRegistry.get('pi')!;

    expect(pi.capabilities.hooks.kind).toBe('plugin');
    if (pi.capabilities.hooks.kind !== 'plugin') throw new Error('Pi hooks should be plugin hooks');
    expect(pi.capabilities.hooks.supportedEvents).toContain('session');
    // 能报结束就必须能报开始(spec hook-status-derivation)。缺 'start' 时 TUI 腿的状态点
    // 结构上只能报空闲,而咕咕投递的回合连宿主那条合成路都不经过 —— owner 2026-09-14 实撞。
    expect(pi.capabilities.hooks.supportedEvents).toContain('start');
    expect(pi.capabilities.hooks.supportedEvents).toContain('stop');

    const fresh = pi.behavior.prompt!.buildCommand({
      cli: 'pi',
      permissionMode: 'edit',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: '',
    });
    expect(fresh.args).toEqual(['Fix the bug']);

    const resumed = pi.behavior.prompt!.buildCommand({
      cli: 'pi',
      cliSessionId: 'conv-1',
      providerSessionId: '/Users/test/.pi/agent/sessions/project/session.jsonl',
      isResuming: true,
      model: '',
    });
    expect(resumed.args).toEqual([
      '--session',
      '/Users/test/.pi/agent/sessions/project/session.jsonl',
    ]);
  });

  it('registers Oh My Pi install, ACP, model, and session behavior', () => {
    const ohMyPi = pluginRegistry.get('oh-my-pi')!;

    expect(ohMyPi.metadata.name).toBe('Oh My Pi');
    expect(ohMyPi.capabilities.acp.kind).toBe('supported');
    expect(ohMyPi.capabilities.hostDependency.binaryNames).toEqual(['omp']);
    expect(ohMyPi.capabilities.hostDependency.installDocs).toBe('https://omp.sh/docs/quickstart');
    // 只认不装:发行物在 GitHub Releases,npm/bun 上那份是纯 JS ⇒ 没有可托管安装的归档。
    expect(ohMyPi.capabilities.hostDependency.installCommands).toEqual({});
    expect(ohMyPi.capabilities.hostDependency.updates).toEqual({ kind: 'none' });
    expect(ohMyPi.capabilities.hostDependency.uninstall).toBeUndefined();

    const fresh = ohMyPi.behavior.prompt!.buildCommand({
      cli: 'omp',
      permissionMode: 'edit',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: 'openai-codex/gpt-5.5',
    });
    expect(fresh.args).toEqual([
      '--extension',
      './.omp/extensions/gugu-hook.ts',
      '--model',
      'openai-codex/gpt-5.5',
      'Fix the bug',
    ]);

    const resumed = ohMyPi.behavior.prompt!.buildCommand({
      cli: 'omp',
      permissionMode: 'edit',
      cliSessionId: 'conv-1',
      providerSessionId: '/Users/test/.omp/agent/sessions/project/session.jsonl',
      isResuming: true,
      model: '',
    });
    expect(resumed.args).toEqual([
      '--extension',
      './.omp/extensions/gugu-hook.ts',
      '--session',
      '/Users/test/.omp/agent/sessions/project/session.jsonl',
    ]);
  });

  it('registers Qoder CLI install metadata and interactive command args', () => {
    const qoder = pluginRegistry.get('qoder')!;

    expect(qoder.metadata.websiteUrl).toBe('https://qoder.com/en/cli');
    // 两个都要:`@qoder-ai/qodercli` 的 npm `bin` 同时发 `qodercli` 与 `qoder`
    // (实测 `npm view @qoder-ai/qodercli bin`),而官方文档一律用 `qoder`。
    // 这条断言原先只钉 `['qodercli']` —— 它编码的是一个与事实不符的预期,
    // 后果是 curl 脚本装的用户被判成「没装」。为什么是这个顺序见 qoder/index.test.ts。
    expect(qoder.capabilities.hostDependency.binaryNames).toEqual(['qodercli', 'qoder']);
    expect(qoder.capabilities.hostDependency.installDocs).toBe('https://qoder.com/en/cli');
    // 托管安装走 npm 后端(本体是 JS);发布出去的启动器只叫 `qodercli`,`qoder` 只用来探测。
    expect(qoder.capabilities.hostDependency.installCommands.macos?.[0]?.command).toBe(
      'mise install npm:@qoder-ai/qodercli',
    );
    expect(qoder.capabilities.hostDependency.installCommands.macos?.[0]?.target).toMatchObject({
      kind: 'mise',
      binary: 'qodercli',
      backend: { kind: 'npm' },
    });

    const fresh = qoder.behavior.prompt!.buildCommand({
      cli: 'qodercli',
      permissionMode: 'full-access',
      initialPrompt: 'Fix the bug',
      cliSessionId: 'conv-1',
      isResuming: false,
      model: '',
    });

    expect(fresh).toEqual({
      command: 'qodercli',
      args: ['--yolo', 'Fix the bug'],
      env: {},
      // argv 上真的有 auto-approve flag(spec hook-status-derivation 的事实源)。
      autoApproved: true,
    });

    const resumed = qoder.behavior.prompt!.buildCommand({
      cli: 'qodercli',
      permissionMode: 'full-access',
      initialPrompt: '',
      cliSessionId: 'conv-1',
      providerSessionId: 'qoder-session-1',
      isResuming: true,
      model: '',
    });

    expect(resumed.args).toEqual(['-r', 'qoder-session-1', '--yolo']);
  });
});

function cliLoginArgs(
  plugin: NonNullable<ReturnType<typeof pluginRegistry.get>>,
  methodId: string,
): string[] | undefined {
  if (plugin.capabilities.auth.kind !== 'supported') return undefined;
  const method = plugin.capabilities.auth.methods.find((candidate) => candidate.id === methodId);
  if (!method || method.kind !== 'cli-login') return undefined;
  return method?.args;
}
