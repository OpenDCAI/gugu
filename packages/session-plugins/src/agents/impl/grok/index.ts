import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  grokSessionBundleDescriptor,
  materializeGrokSessionBundle,
} from './session-bundle';
import {
  buildStandardCommand,
  recognisedDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';
import { grokMcpAdapter } from './mcp';

const sessionBundle = grokSessionBundleDescriptor satisfies SessionBundleDescriptor;

/**
 * grok 自己会去读的规则 / 记忆文件。
 *
 * 出处:https://docs.x.ai/build/features/project-rules —— 官方页原文「Within each directory,
 * Grok reads any of AGENTS.md, Agents.md, AGENT.md, CLAUDE.md, Claude.md, and CLAUDE.local.md,
 * plus every *.md file in a `.grok/rules/` directory」,加载顺序是「Global rules in ~/.grok/,
 * 以及从 repo root 到工作目录的每一层」,深的覆盖浅的。
 *
 * ⚠️ **global 那一层没登记**:官方页只说「Global rules in `~/.grok/`」,没有点名 home 下的
 * 具体文件名(是 `~/.grok/AGENTS.md` 还是 `~/.grok/rules/*.md` 页面没写)。猜一个填进去就是
 * 假账 —— 缺这一条是有界的欠账,查到官方点名的路径再补。
 *
 * ⚠️ 同一目录下 `AGENTS.md` 那六个兼容别名只登记推荐名一条,理由同 droid:官方页没给别名之间的
 * 确定顺序,全登记会把「引擎实际读了哪一份」变成猜。`.grok/rules/` 是**并列**加载(原文 plus),
 * 不在那条优先级链上,所以可以一起登记。
 */
const grokMemory = {
  kind: 'files',
  entries: [
    // 相对工作区根
    { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
    // 目录入口:只收顶层 *.md(目录里混着 README/备份是常态,全收会把不是规则的东西当规则读回来)
    {
      kind: 'directory',
      scope: 'project',
      channel: 'vendor-file',
      path: '.grok/rules',
      suffixes: ['.md'],
    },
  ],
} satisfies AgentMemoryDescriptor;

export const plugin = definePlugin(
  {
    id: 'grok',
    name: 'Grok',
    description:
      "xAI's Grok CLI for terminal-first coding sessions with plans, subagents, and parallel work.",
    websiteUrl: 'https://docs.x.ai/build/overview',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    // hooks:终端腿**没有**会话级通道(1.0.13,`upstream-blocked`)⇒ 如实声明 none,
    // ❌ 不写 `~/.grok/hooks/`(那是用户全局配置,#6195)。取证:
    //  · `--plugin-dir`(会话级、自动受信)只在 `grok agent … stdio` 上;交互 `grok` 对它报
    //    `error: unexpected argument '--plugin-dir' found`(与一个编造的 flag 同一条 clap 报错);
    //  · `GROK_CONFIG` / `GROK_CONFIG_PATH` overlay 是 allowlist(models/features/toolset…),
    //    厂商原文「cannot spawn commands … or add a discovery source」⇒ 装不了 hooks;
    //  · 工作区 `.grok/hooks/` 要 folder trust,交互 `grok` 没有 `--trust`;挪 `GROK_HOME` 要复制用户凭据(spec 禁止)。
    //  出处:https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.13.tgz
    //  二进制内嵌 user-guide 05-configuration.md / 09-plugins.md / 10-hooks.md,`grok --help`;公开源码
    //  xai-org/grok-build@07e35a3dfe(1.0.41)crates/codegen/xai-grok-pager/src/app/cli.rs:283 —— `plugin_dirs`
    //  只声明在 `AgentArgs`(`grok agent` 子命令)上。取证 2026-09-22。
    //  上游没有公开 issue tracker(grok-build 关了 Issues/Discussions、CONTRIBUTING 声明不收外部贡献,
    //  反馈只走应用内 `/feedback`)⇒ 需求原文在 #6206,由 owner 决定是否提交。
    //  终端腿因此没有状态源;「没有状态源的会话如实显示状态不可用」是 #6206。ACP 腿的回合边界走协议更新
    //  (见 session-bundle 的 observability)。
    hooks: { kind: 'none' },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装 —— 这一家的理由**不是**分发形态:它的 npm 包在 node 下跑得起来
    // (bin `bin/grok` 是个 JS 启动器,自己解压平台包里的 `bin/grok.br`),aube 装得了。
    // 拦住它的是本仓自己的钉子:权限档与会话包是按 **1.0.13** 那一版量出来的
    // (`updates: {kind:'none'}` 就是为此),而托管安装装的是该下载源上的当前发布版(今天 1.0.40)。
    // ⇒ 要接进来得先照新版重量一次权限档、再解开这个钉子;在那之前装一个没量过的版本
    //    比不装更糟(2026-09-22)。
    hostDependency: recognisedDependency({
      binaryNames: ['grok'],
      installDocs: 'https://docs.x.ai/build/overview',
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    memory: grokMemory,
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
  },
  { icon },
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: {
    materialize: materializeGrokSessionBundle,
  },
  acp: createNativeAcpBehavior(() => ({
    args: ['agent', 'stdio'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--always-approve',
        initialPromptFlag: '',
        resumeFlag: '-r',
        cliSessionIdFlag: '-r',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-r',
        modelFlag: '-m',
      }),
  },
  mcp: grokMcpAdapter(),
});
