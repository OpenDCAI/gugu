import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  continueSessionBundleDescriptor,
  materializeContinueSessionBundle,
} from './session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { icon } from './icon';

const sessionBundle = continueSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'continue',
    name: 'Continue',
    description:
      'Continue CLI is a modular coding agent with configurable models, rules, and MCP tool support.',
    websiteUrl: 'https://docs.continue.dev/guides/cli',
  },
  {
    sessionBundle,
    autoApprove: {
      kind: 'supported',
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 托管安装(npm backend):纯 JS(bin `dist/cn.js`)+ 运行期依赖(含 sharp 的原生件,
    // 由 aube 按本机平台挑)。
    hostDependency: miseDependency({
      id: 'cn',
      backend: 'npm',
      package: '@continuedev/cli',
      node: MANAGED_NODE_VERSION,
    }),
    /**
     * agent memory —— Continue CLI **自己会去读**的记忆文件。
     *
     * 出处全部取自它自己的源码(`continuedev/continue@5522c6f4`,取证 2026-08-24):
     *  · `extensions/cli/src/systemMessage.ts` 的 `constructSystemMessage()`:
     *    `const agentFiles = ["AGENTS.md","AGENT.md","CLAUDE.md","CODEX.md"]`,逐个在
     *    `process.cwd()` 下找,**第一个存在的**读进系统消息(`break`)。
     *  · 同文件 `loadMarkdownRulesWithMetadata()`:扫两个目录
     *    `<cwd>/.continue/rules` 与 `<continueHome>/rules`,只收 `.md`;
     *    `extensions/cli/src/env.ts` 里 `continueHome = CONTINUE_GLOBAL_DIR || ~/.continue`。
     *
     * ⚠️ 只登记 `AGENTS.md` 一个 agent 文件:另外三个(`AGENT.md` / `CLAUDE.md` / `CODEX.md`)
     * 是别家的专名文件,登给 continue 会让同一份文件在多家的读数里重复出现,分不清是谁的记忆。
     * ⚠️ 引擎那两个 rules 目录是 `readdirSync(dir, { recursive: true })` —— **递归**;而
     * `AgentMemoryEntry` 的 directory 形态只收顶层。子目录里的规则读不回来,是已知欠账。
     * ⚠️ `CONTINUE_GLOBAL_DIR` 被用户改过时,global 那一条会读到空 —— 宿主那把 fs 恒锚在 home,
     * 声明里表达不了环境变量。同样是已知欠账,不是错登记。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.continue/rules',
          suffixes: ['.md'],
        },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.continue/rules',
          suffixes: ['.md'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon },
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeContinueSessionBundle },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--auto',
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
});
