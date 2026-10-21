import {
  PLATFORM_NOT_WIRED,
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  createUnverifiedSessionBundleBehavior,
  UNVERIFIED_SESSION_BUNDLE_DELIVERY,
} from '../../helpers/session-bundle';
import { buildStandardCommand, recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';

const sessionBundle = {
  injectionMode: 'runtime' as const,
  platform: PLATFORM_NOT_WIRED,
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': { identity: 'none', messageTransport: 'none' },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
  },
  units: {
    mcp: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    env: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    model: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  coexistence: {
    // 这四条都由 ACP 腿(`surfaces` 含 'acp',provider.acp = createNativeAcpBehavior)提供,
    // 与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    //  · plan:decode 出 { kind:'plan', entries } 后由 reducer/item-fold 折进 transcript。
    //  · observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState
    //    产出 isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    //  · askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options
    //    的待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //    resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕
    //    没通,❌ 不许声明。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // memory:对应下面 `capabilities.memory` 登记的那几个文件 —— 登记了,宿主
    // `AgentPluginHost.readMemoryFiles` 就真读得回来。通道取 `agents-md`:junie 的现行格式
    // 就是 AGENTS.md 那一族(`.junie/AGENTS.md` 与仓根 `AGENTS.md`),`.junie/playbook.md`
    // 与 `.junie/guidelines.md` 是它自己的专名文件,一并登记但不作声明通道。
    memory: { kind: 'native', channel: 'agents-md' },
    // 其余三维落回基类:junie 没有 mcp / hooks 行为(无处 config-scan),
    // 历史读回也只接了 claude-code 与 codex(transcriptInventory.ts)。
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      'JetBrains agentic coding CLI for interactive terminal and headless project workflows.',
    websiteUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:jetbrains 只提供 `junie.jetbrains.com/install.sh`。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({ binaryNames: ['junie'] }),
    // agent memory —— junie 的 guidelines 一族。
    // 出处:https://junie.jetbrains.com/docs/guidelines-and-memory.html(取证 2026-08-24)。
    // 原文的查找顺序:
    //   1.「.junie/AGENTS.md file in the project root.」
    //   2.「AGENTS.md file in the project root, combined with .junie/playbook.md and every
    //      .junie/rules/*.md file, if present.」
    //   3.「.junie/guidelines.md file or .junie/guidelines/ folder – Junie's legacy format for
    //      guidelines (still supported).」
    // global:同页「~/.junie/AGENTS.md. On Windows, the global guidelines path is
    //   %USERPROFILE%\.junie\AGENTS.md.」→ 登记为 global 作用域的 `.junie/AGENTS.md`
    //   (路径相对 home,PluginFs 的 root 就是 home)。
    // ⚠️ `.junie/guidelines/` 那个**目录**形态没登记:`AgentMemoryEntry` 的 directory 只收顶层,
    //    而官方没说这个目录是不是只有一层、收哪些后缀 —— 少登记只是欠账,登记错会读回不是记忆的东西。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle:capability schema 钉的是
    //    `z.ZodType<AgentMemoryDescriptor>`,zod 4 会把 Input 留成 `unknown`。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.junie/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: '.junie/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.junie/playbook.md' },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.junie/rules',
          suffixes: ['.md'],
        },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.junie/guidelines.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'argv',
      flag: '--task',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp=true'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        initialPromptFlag: '--task',
        cliSessionIdFlag: '--session-id',
      }),
  },
});
