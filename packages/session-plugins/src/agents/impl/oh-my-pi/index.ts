import type { AgentMemoryDescriptor, CommandContext } from '@gugu/session-core/agents/plugins';
import {
  definePlugin,
  registerPluginBehavior,
} from '@gugu/session-core/agents/plugins';
import { buildStandardCommand, createFileDropPlugin, recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';
import { OH_MY_PI_EXTENSION_CONTENT } from './plugin-file';
import {
  materializeOhMyPiSessionBundle,
  ohMyPiSessionBundleDescriptor,
} from './session-bundle';

const OH_MY_PI_EXTENSION_PATH = '.omp/extensions/gugu-hook.ts';
const OH_MY_PI_EXTENSION_ARG = `./${OH_MY_PI_EXTENSION_PATH}`;

export const plugin = definePlugin(
  {
    id: 'oh-my-pi',
    name: 'Oh My Pi',
    description:
      'Terminal-first coding agent with LSP, debugger, subagents, browser tools, and ACP support.',
    websiteUrl: 'https://omp.sh',
  },
  {
    sessionBundle: ohMyPiSessionBundleDescriptor,
    acp: {
      kind: 'supported',
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['session', 'stop'],
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:oh-my-pi 的发行物在 GitHub Releases(`omp.sh/install` 去那儿取),
    // npm/bun 上的 `@oh-my-pi/pi-coding-agent` 是纯 JS 且有 25 个运行期依赖 ⇒
    // 两条路都拿不到可直接执行的 npm 平台包(核于 2026-09-21)。
    // ❌ 厂商脚本 / Homebrew / bun 三条并列的产品内装法一并删除(#6098)。
    hostDependency: recognisedDependency({
      binaryNames: ['omp'],
      installDocs: 'https://omp.sh/docs/quickstart',
    }),
    // agent memory —— omp 管这一族叫 **context files**,会话开始前自动发现并注入,用户不用喊它去读。
    // 出处:官方文档 https://github.com/can1357/oh-my-pi/blob/main/docs/context-files.md
    //      (can1357/oh-my-pi@989271449953548f1a399789bfc7500003115ebc)的「Native `.omp` files」表:
    //  · `~/.omp/agent/AGENTS.md`  用户层 context(`~/.omp/agent` = 活动 native agent 目录,
    //    `PI_CODING_AGENT_DIR` 可改;`--profile` 走 `~/.omp/profiles/<name>/agent`);
    //  · `~/.omp/agent/RULES.md`   用户层 sticky rules —— 同一张表列的另一份文件,不是 AGENTS.md 的别名;
    //  · `<最近的非空 .omp/>/AGENTS.md` 与 `RULES.md` 项目层;
    //  · 另有 `agents-md` provider 收**独立**的 `AGENTS.md`(同表最后一行,优先级 10)。
    // ⚠️ 项目层的真实规则是「从 cwd 往上找**最近的非空** `.omp/` 目录」——咕咕这一侧只读工作区根
    //    那一层(project fs 锚在工作区根,越界会被 resolveSafe 拒)。少读不是错报。
    // ⚠️ 同表还有 shadowing:同一深度上 `native`(100)盖 `agents-md`(10),所以真机上
    //    `.omp/AGENTS.md` 与根 `AGENTS.md` 同时存在时 omp 只用前者。这里两条都登记,是因为
    //    本 descriptor 记的是「入口在哪」,不是「这一次哪一份赢」——读回来的 content 为 null 即不存在。
    // ⚠️ ❌ 不登记 `docs/memory.md` 那套 memory backend(local / hindsight / mnemopi):它默认关闭,
    //    且产物走 `memory://` 虚拟 URL,没有可声明的稳定磁盘路径。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.omp/agent/AGENTS.md' },
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.omp/agent/RULES.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: '.omp/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.omp/RULES.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      resumeNeedsProviderId: true,
      // Context7: /can1357/oh-my-pi documents `--fork <id|path>` as creating
      // a new session file from an existing session identifier or path.
      fork: 'supported',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeOhMyPiSessionBundle },
  acp: createNativeAcpBehavior(() => ({
    args: ['acp'],
  })),
  prompt: {
    buildCommand: (ctx: CommandContext) =>
      buildStandardCommand(ctx, {
        defaultArgs: ['--extension', OH_MY_PI_EXTENSION_ARG],
        initialPromptFlag: '',
        resumeFlag: '--session',
        cliSessionIdFlag: '--session',
        cliSessionIdOnResumeOnly: true,
        modelFlag: '--model',
        forkCommand: '--fork',
      }),
  },
  plugins: createFileDropPlugin({
    relativePath: OH_MY_PI_EXTENSION_PATH,
    content: OH_MY_PI_EXTENSION_CONTENT,
    legacyRelativePaths: ['.omp/extensions/emdash-hook.ts'],
  }),
});

export {
  OH_MY_PI_ACP_SOURCE,
  OH_MY_PI_ACP_VERSION,
  materializeOhMyPiSessionBundle,
  ohMyPiSessionBundleDescriptor,
} from './session-bundle';
