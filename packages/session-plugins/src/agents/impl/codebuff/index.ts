import {
  PLATFORM_NOT_WIRED,
  definePlugin,
  registerPluginBehavior,
  TUI_INTERRUPT_PAUSE,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  createUnverifiedSessionBundleBehavior,
  UNVERIFIED_SESSION_BUNDLE_DELIVERY,
} from '../../helpers/session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { icon } from './icon';

const sessionBundle = {
  injectionMode: 'runtime' as const,
  platform: PLATFORM_NOT_WIRED,
  shellEnv: { passThrough: ['CODEBUFF_API_KEY'] },
  surfaces: ['tui'],
  sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'local-session' } },
  units: {
    mcp: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    env: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    model: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  // 只写咕咕**真接通了**的维度;没写的落回 BASE_SESSION_COEXISTENCE(= 尚未接通)。
  coexistence: {
    // TUI 腿的暂停 = 往 pty 写这一家自己的中断键(主干见
    // `session-core/.../capabilities/tui-coexistence.ts`,展开由 `tuiInterruptWrites` 负责,
    // 宿主写入在 `apps/desktop/electron/session/main/core/pty/controller.ts` 的 interrupt())。
    // ⚠️ 字面量不自己手写,取主干常量 —— 通道名一旦漂,读侧就认不出这是同一条通道。
    pause: TUI_INTERRUPT_PAUSE,
    // 引擎自己会去读的记忆文件已登记在下面的 `capabilities.memory`(knowledge.md 系),
    // 宿主经 `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `vendor-file`:codebuff 的首选名是它自己的 `knowledge.md`,不是 AGENTS.md 约定。
    memory: { kind: 'native', channel: 'vendor-file' },
  },
  // ❌ 其余各维不写,落回基类(= 咕咕还没接,**不是** codebuff 做不到):
  //  · observability —— codebuff 的 `hooks` descriptor 是 `none`,咕咕从没给它写过 hook /
  //    plugin 文件,`GUGU_HOOK_*` 那组环境变量没有任何消费者 → 没有回传链。
  //  · askUser —— 只有 tui 一条腿,去程只有布尔通知、回程 sendInput 写的是终端而非某个
  //    待决请求(理由与出处见 tui-coexistence.ts 末尾),往返不成立。
  //  · introspection —— 本文件没注册 mcp behavior,没有 readServers 那条读**用户自己**配置的路。
  //  · todo / history / cron —— 咕咕这边没有任何读回或下发的通道。
  /**
   * TUI 腿的中断键。
   *
   * 两份**一手**出处,互相印证(取证 2026-08-24;❌ 都不是 #3889 答案键那一列的转述 ——
   * 那一列是二手转述,`zero.pause` 已经被查出把 Esc / Ctrl-C 的语义记反了):
   *  1. 厂商自己发布的 npm 包 README(`codebuff@1.0.685`,dist-tags.latest)「Tips」第 4 条:
   *     Press Esc or Ctrl+C while Codebuff is generating a response to stop it.
   *  2. 上游源码 `CodebuffAI/freebuff@b600a179`(该仓由 `CodebuffAI/codebuff` 改名而来,
   *     `gh api repos/CodebuffAI/codebuff` 会 302 到它)的
   *     `cli/src/utils/keyboard-actions.ts` Priority 4:
   *     `(isEscape || isCtrlC) && (state.isStreaming || state.isWaitingForResponse)`
   *     → `{ type: 'interrupt-stream' }`。**单按**即中断,源码里没有任何双击计数,
   *     也不走退出路径。
   *
   * ⚠️ 两个键里**只取 Esc**:Ctrl-C 在不少 TUI 上是退进程,而本维语义是**暂停** ——
   * 进程活着、会话还在、能接着说。宁可少一条路,也不能把「暂停」按成「杀掉」。
   * ⚠️ 已知不完美:同一份源码的 Priority 2 里,用户处在**非 default 输入模式**时,Esc 先退出
   * 那个模式、这一轮不被打断。那是「没停下」,不是「停错了」,可接受。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'codebuff@1.0.685 npm README «Tips» #4 "Press Esc or Ctrl+C while Codebuff is generating '
      + 'a response to stop it." — https://www.npmjs.com/package/codebuff；源码印证 '
      + 'CodebuffAI/freebuff@b600a179e7fa5bfde929dd227a036ed5621968d3 '
      + 'cli/src/utils/keyboard-actions.ts Priority 4 单按 escape → interrupt-stream '
      + '(取证 2026-08-24)',
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'codebuff',
    name: 'Codebuff',
    description:
      'Codebuff is an AI coding agent for project-directory assistance and day-to-day development tasks.',
    websiteUrl: 'https://www.codebuff.com/docs/help/quick-start',
  },
  {
    sessionBundle,
    // 托管安装(npm backend):包本身是个 JS 启动器,aube 把它连依赖一起装好。
    // ⚠️ 它**第一次跑**时还会自己去 codebuff.com/api/releases 取真正的二进制 ——
    //    那一步在咕咕的下载源之外,选哪个镜像都不影响它(2026-09-21 核)。
    hostDependency: miseDependency({
      id: 'codebuff',
      backend: 'npm',
      package: 'codebuff',
      node: MANAGED_NODE_VERSION,
    }),
    /**
     * agent memory —— codebuff **自己会去读**的知识文件。
     *
     * 出处(取证 2026-08-24):
     *  · https://www.codebuff.com/docs/tips/knowledge-files —— 项目内 `knowledge.md`;
     *    家目录候选 `~/.knowledge.md` → `~/.AGENTS.md` → `~/.CLAUDE.md`,**只用第一个找到的**;
     *  · https://www.codebuff.com/docs/help/faq —— 每个目录里按 `knowledge.md` → `AGENTS.md`
     *    → `CLAUDE.md` 取其一。
     *
     * ⚠️ 这里登记的是「引擎会去读的文件」,不是「引擎这一次读了哪个」:codebuff 每个目录只取
     * 优先级最高的那一个,咕咕这边把候选都读回来,内容为 null 就是磁盘上没有(用户没写过)。
     * ❌ 不登记 `CLAUDE.md` —— 那是 claude 的专名文件,登给 codebuff 会让同一份文件在两家的
     * 读数里重复出现,分不清是谁的记忆。
     * ⚠️ 只收顶层:`knowledge.md` 可以放在任意子目录(`backend/knowledge.md`),而
     * `AgentMemoryEntry` 没有递归形态 —— 子目录那些读不回来,是已知欠账不是错登记。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.knowledge.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'knowledge.md' },
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
      kind: 'stateless',
    },
  },
  { icon },
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        initialPromptFlag: '',
      }),
  },
});
