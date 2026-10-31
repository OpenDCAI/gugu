import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  auggieSessionBundleDescriptor,
  materializeAuggieSessionBundle,
} from './session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { buildAuggieHookConfig } from './hooks';
import { icon } from './icon';

const sessionBundle = auggieSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'auggie',
    name: 'Auggie',
    description:
      'Augment Code CLI to run an agent against your repository for code changes and reviews.',
    websiteUrl: 'https://docs.augmentcode.com/cli/overview',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
    },
    // 托管安装(npm backend):纯 JS(bin `augment.mjs`),依赖树交给 aube。
    // `versionLine`:`--version` 里它自己那一行,实测原样「0.36.0 (commit 7c61e5bb)」(包装器的 banner 在它前面)。
    hostDependency: { ...miseDependency({
      id: 'auggie',
      backend: 'npm',
      package: '@augmentcode/auggie',
      node: MANAGED_NODE_VERSION,
    }), versionLine: /^\d+\.\d+\.\d+ \(commit / },
    /**
     * agent memory —— auggie 自己会去读的规则文件。官方文档
     * https://docs.augmentcode.com/cli/rules.md(取证 2026-08-24)原文列了六条:
     * 1 `--rules` 自定义文件 / 2 `CLAUDE.md` / 3 `AGENTS.md` / 4
     * `<workspace_root>/.augment-guidelines` / 5 `<workspace_root>/.augment/rules/` /
     * 6 `~/.augment/rules/`;同页作用域表把 5、6 明确分成 Workspace 与 User 两级。
     *
     * ⚠️ 这里只登记其中三条,**其余是刻意不登记的**:
     *  · `CLAUDE.md` 与 `.augment-guidelines` 跟 `AGENTS.md` 同在那张「order of precedence」
     *    清单里,而文档**没说**几条同时存在时是全读还是先命中先停。是「先命中先停」的话,
     *    把三条都登记就会在两份都存在时读回两份 —— 把「二选一」记成「都要」,比缺一条更错。
     *    要补先拿到「同时读」的一手出处。
     *  · `--rules` 那条是启动参数指定的任意路径,不是固定位置,建模不了。
     *
     * ⚠️ `.augment/rules` 登记成 directory 入口,后缀取 `.md` 与 `.mdc`:文档只写了 `.md`,
     * 但官方分发的 `@augmentcode/auggie@0.36.0` 的 `package/augment.mjs` 里
     * `hfi=".md",Afi=".mdc",OAn=[hfi,Afi]`,`processRuleDirectory` 按 `OAn.some(...)` 收 ——
     * 实现比文档宽,这里以实现为准。
     *
     * ⚠️ 已知不完整:文档与实现都会**递归**子目录,而 `AgentMemoryEntry` 的 directory 入口
     * 只收顶层(`readAgentMemoryDocuments` 用 `fs.list` 不下钻)。规则放在
     * `.augment/rules/<子目录>/x.md` 的用户会少读到那几条。这是模型的限制,不是这份声明写错。
     */
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.augment/rules',
          suffixes: ['.md', '.mdc'],
        },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.augment/rules',
          suffixes: ['.md', '.mdc'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeAuggieSessionBundle },
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp'],
    env: {
      AUGMENT_DISABLE_AUTO_UPDATE: '1',
    },
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        defaultArgs: ['--allow-indexing'],
        initialPromptFlag: '',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
      }),
  },
  hooks: buildAuggieHookConfig(),
});
