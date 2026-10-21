import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  commandcodeSessionBundleDescriptor,
  materializeCommandcodeSessionBundle,
} from './session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { buildCommandCodeHookConfig } from './hooks';
import { icon } from './icon';

const sessionBundle = commandcodeSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'commandcode',
    name: 'Command Code',
    description:
      'Command Code CLI for terminal-first coding sessions that learn project and personal coding taste.',
    websiteUrl: 'https://commandcode.ai/docs/reference/cli',
  },
  {
    sessionBundle,
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['session', 'stop'],
    },
    // 托管安装(npm backend):纯 JS(bin `dist/index.mjs`)+ 47 个运行期依赖。
    // ⚠️ `id` 是**发布出去的那个启动器名**,取厂商文档里的主名 `command-code`;
    //    另外两个别名仍然会被自动探测认出来(用户自己装的那份)。
    hostDependency: miseDependency({
      id: 'command-code',
      // 同一个包的 npm `bin` 发四个名字(`cmd` / `cmdc` / `commandcode` / `command-code`),
      // 用户自己装的那份可能是任意一个;咕咕自己发布的启动器只叫主名。
      aliases: ['commandcode', 'cmdc'],
      backend: 'npm',
      package: 'command-code',
      node: MANAGED_NODE_VERSION,
    }),
    /**
     * agent memory —— Command Code **自己会去读**的记忆文件。
     *
     * 出处:https://commandcode.ai/docs/memory(取证 2026-08-24)——
     *  · 项目:`<project>/AGENTS.md` 与 `<project>/.commandcode/AGENTS.md` 按此顺序检查,
     *    「the first one that exists is used, not both」;
     *  · 用户:`~/.commandcode/AGENTS.md`(across every project)。
     * 同页原文「Command Code reads AGENTS.md, not CLAUDE.md」→ 三条全走 `agents-md` 通道,
     * ❌ 不登记 CLAUDE.md。
     *
     * ⚠️ 项目两条是**候选**不是「都会被读」:引擎取先存在的那一个,咕咕把两个候选都读回来,
     * 内容为 null 即磁盘上没有。
     * ⚠️ 子目录里的 AGENTS.md(引擎会从文件所在目录往上走一路收)读不回来:`AgentMemoryEntry`
     * 没有递归形态。已知欠账,不是错登记。
     * ⚠️ ❌ 不登记 taste(`.commandcode/taste/…`):#3889 的证据串提到它,但我没找到官方文档
     * 写死其路径 —— 路径填错的后果是静默读到空,宁可留欠账。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.commandcode/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: '.commandcode/AGENTS.md' },
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
      resumeNeedsProviderId: true,
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeCommandcodeSessionBundle },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        defaultArgs: ['--trust', '--skip-onboarding'],
        autoApproveFlag: '--yolo',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
      }),
  },
  hooks: buildCommandCodeHookConfig(),
});
