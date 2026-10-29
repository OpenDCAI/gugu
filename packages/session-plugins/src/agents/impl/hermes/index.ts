import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  buildStandardCommand,
  recognisedDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { requireBridgeEntry } from '../../helpers/acp-bridge-entry';
import { HERMES_PERMISSION_MODES } from './permission-modes';
import {
  hermesSessionBundleDescriptor,
  materializeHermesSessionBundle,
} from './session-bundle';
import { icon } from './icon';
import { hermesSubscription } from './subscription';
import { hermesMcpAdapter } from './mcp';

/**
 * Hermes 自己会去读的记忆文件。
 *
 * 出处 https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files:
 *  · project —— 官方页原文「Only **one** project context type is loaded per session
 *    (first match wins): `.hermes.md` → `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md`
 *    → `.cursorrules`」;
 *  · global  —— 「Hermes loads `SOUL.md` only from `HERMES_HOME`」,默认 `~/.hermes/SOUL.md`
 *    (另见 https://hermes-agent.nousresearch.com/docs/user-guide/features/personality)。
 *
 * ⚠️ project 那条链是「命中第一个就停」,所以只登记 `AGENTS.md` 这一档:把 `.hermes.md` 或
 * `CLAUDE.md` 一起登记,会在用户同时有两个文件时读回引擎**根本没读**的那一份。用户用的是
 * `.hermes.md` 时咕咕读回空 —— 那是欠账,不是假账。
 * ⚠️ `HERMES_HOME` 被改过时 global 那条读回空,同上。要收敛得先读得到环境变量,不在本维。
 */
const hermesMemory = {
  kind: 'files',
  entries: [
    // 相对 home:~/.hermes/SOUL.md
    { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.hermes/SOUL.md' },
    // 相对工作区根
    { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
  ],
} satisfies AgentMemoryDescriptor;

export const plugin = definePlugin(
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description:
      'Nous Research terminal agent with interactive chat, model-provider routing, skills, and session workflows.',
    websiteUrl: 'https://hermes-agent.nousresearch.com/docs/',
  },
  {
    sessionBundle: hermesSessionBundleDescriptor,
    // 「订阅」页(product spec):Hermes 本身免费，读它接的是哪家;Nous 余量只有 Hermes 自己报(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    vendorAccount: {
      kind: 'not-required',
      evidence:
        'hermes serve + 托管层具名 provider 指向本地假 Responses 端点、零 Nous 账号:每个请求都带托管 key、从不用用户 .env 的 key'
        + '(Phase 0,v2026.9.24 与 main ddde0670 两端同读数,builds/hermes/SERVE-BRIDGE-DESIGN.md)',
    },
    /**
     * Hermes 的推理阶梯(`hermes_constants.VALID_REASONING_EFFORTS` + `none` = 关思考;Hermes Desktop 的
     * `REASONING_EFFORT_VALUES` 同一组)。活会话里桥按模型报 `thought_level`(平台模型 = 目录里该模型认的那几档),
     * 这一份只在还没有活会话时给新建页一个词表 —— 只装了咕咕平台模型、没配自己 provider 的用户,探针报不出档位。
     */
    effort: {
      kind: 'selectable',
      effortOptions: {
        none: { name: '关闭', description: '这一轮不做额外推理' },
        minimal: { name: '最低', description: '只做必要的简短推理' },
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
        ultra: { name: '超量', description: '比最高还深;线路不支持时 Hermes 压回它能送的最高一档' },
      },
    },
    acp: {
      kind: 'supported',
      /**
       * The bridge (`runtime/hermes-serve-acp.ts`) speaks `hermes serve` — Hermes Desktop's own backend — and
       * reports the three settings as standard ACP `configOptions` (`mode` / `model` / `thought_level`). Each
       * is one session-scoped `config.set` there, the call Hermes Desktop's composer makes; none writes the
       * user's config.yaml. The answer echoes the applied value ⇒ `ack-read-back`. Hermes applies all three from
       * the next model request; a model switch while a turn runs (or on a compute-host session) is `deferred`
       * to the next turn ⇒ `busy: 'queue-next-turn'`. Phase 0 readings (v2026.9.24 and main ddde0670):
       * builds/hermes/SERVE-BRIDGE-DESIGN.md.
       */
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        effort: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    /**
     * 用户那份是 `~/.hermes/config.yaml` 的 `mcp_servers`;写口由共享适配器 `assertWritable` 钳死。
     * 咕咕那几台经 `session/new.mcpServers` 交给桥,桥写进 serve 的托管层(`HERMES_MANAGED_DIR`),与用户的
     * 配置逐项合并注册;hermes 默认开着渐进披露,MCP 工具只经 `tool_call` 桥按全名 `mcp__<server>__<tool>` 调用。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      sessionUserServers: 'inherit',
      toolNames: {
        kind: 'per-surface',
        surfaces: {
          'acp': {
            kind: 'proxied',
            prefix: 'mcp__gugu__',
            proxyTool: 'tool_call',
            evidence:
              'NousResearch/hermes-agent@6f7a7991bb `tools/tool_search.py`:MCP 工具只以名字出现在 tool_search 清单里,'
              + '经 tool_call 调用;裸 ACP 实测 0.21.0–0.21.5 与 main 均收到 tools/call(2026-09-28)',
          },
        },
      },
    },
    autoApprove: {
      kind: 'supported',
      modes: HERMES_PERMISSION_MODES,
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:nousresearch 只提供 `hermes-agent.nousresearch.com/install.sh`。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    // `versionLine`:`--version` 里它自己那一行,实测原样「Hermes Agent v0.21.0 (2026.8.31) · upstream …」(mac1 10-07;后面几行还有
    // Python / OpenAI SDK 的版本,包装器的 banner 在它前面)。
    hostDependency: { ...recognisedDependency({
      binaryNames: ['hermes'],
      installDocs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    }), versionLine: /^Hermes Agent v/ },
    memory: hermesMemory,
    // 终端腿不开(见 session-bundle 的 `surfaces`),这一格只是如实说明为什么没有首句通道。
    prompt: {
      kind: 'none',
      reason: 'Gugu offers Hermes only as a Work (ACP) session; the terminal form is not offered.',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeHermesSessionBundle, platformModel },
  subscription: hermesSubscription,
  mcp: hermesMcpAdapter(),
  acp: {
    // Gugu's own bridge to `hermes serve` (the backend Hermes Desktop uses), built with the app; the host
    // resolves its entry (#6394). It drives the user's own `hermes`: their HERMES_HOME, providers and sessions.
    bridge: { kind: 'app-runtime', file: 'hermes-serve-acp.mjs' },
    buildSpawn: (ctx) => ({
      command: process.execPath,
      executable: ctx.cli,
      args: [requireBridgeEntry(ctx, 'hermes')],
      env: { ELECTRON_RUN_AS_NODE: '1', GUGU_HERMES_BIN: ctx.cli },
    }),
    connect: (io, toClient) => connectStdioAcp(io, toClient),
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--yolo',
        resumeFlag: '--continue',
      }),
  },
});

export {
  hermesSessionBundleDescriptor,
  materializeHermesSessionBundle,
} from './session-bundle';
