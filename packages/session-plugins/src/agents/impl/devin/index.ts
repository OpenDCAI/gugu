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
import { buildDevinHookConfig } from './hooks';
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
    // acp leg: the protocol cancel settles the turn as its own `cancelled` outcome —
    // the process stays up and the session keeps talking (acp/models/turns/turn.ts:22,45).
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // acp leg: `projectSessionState` reports the live turn — `isGenerating` / `canCancel` /
    // `lifecycle` (session-runtime/src/acp-agents/machine/machine.ts:410,413).
    observability: { kind: 'native', channel: 'acp-update' },
    // acp leg: authorization-type asks round-trip to the human — the agent's
    // `session/request_permission` becomes a pending request with options
    // (session-runtime/src/acp-agents/session/cell.ts:318), surfaces in the UI
    // (session-chat-ui/src/state/chat-state.ts:364), and the user's pick settles it (cell.ts:299).
    // ❌ Not the clarification-type ask (`mcp-elicitation` / `native-tool`): Gugu has no such route.
    askUser: { kind: 'native', channel: 'permission-ask' },
    // acp leg: `plan` session updates are normalized into structured entries, not prose
    // (acp/reducer/normalized-event.ts:155).
    todo: { kind: 'native', channel: 'acp-plan' },
    // 引擎自己会去读的规则文件已登记在下面的 `capabilities.memory`,宿主经
    // `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `agents-md`:devin 官方把 `AGENTS.md` 列为 recommended,走的是跨厂商约定
    // (登记里同时有它自己的 `.devin/rules` 与 `.devin/global_rules.md`,走 vendor-file)。
    memory: { kind: 'native', channel: 'agents-md' },
    // ⚠️ `pause` 保持 ACP 腿的 `protocol-cancel`,**不**改成 `interrupt-key`:一维只记得下一个
    // channel,而 protocol-cancel 是更强的那条。TUI 腿的中断键单独记在下面的 `sessionTuiInterrupt`
    // 里(判据见 tui-coexistence.ts 的 `tuiInterruptSurfaceRequirement`:按「有没有 pty 可写」判,
    // 不按 pause 的 channel 判)。
    // ⚠️ No `introspection`: Devin registers no MCP behavior, and the one config Gugu reads back
    // for it is `.devin/hooks.v1.json`, where `readHooks` answers nothing but whether Gugu's *own*
    // managed entries are present (agents/plugins/helpers/hook-config.ts:155). Reading back what
    // we injected is not enumerating the user's.
  },
  /**
   * TUI 腿的中断键 —— 让 `ptyController.interrupt` 对 devin 的 pty 会话有字节可写。
   *
   * 出处:https://docs.devin.ai/cli/reference/keyboard-shortcuts 的 Input 快捷键表
   * (取证 2026-08-24):`Esc` = "Cancel running agent";`Ctrl+C` = "Cancel current input
   * (clears text), or cancel running agent";`Ctrl+D` = "Exit (when input is empty)"。
   *
   * ⚠️ **单按**即取消本轮:该表里 `Esc` 只列一行,没有任何双击语义,所以
   * `presses` 保持缺省 1。❌ 绝不能写 2:devin 在 agent **空闲**时双击 Esc 会开一个
   * 「回退到某一步」的选择器 —— 那是回滚,不是暂停。
   * ❌ 不用 Ctrl-C:它在输入框有字时先清空输入(会吃掉用户半输的一句话),
   * 语义不单纯;Esc 只做一件事。
   * ⚠️ ❌ 本条**不**采信 #3889 答案键那一列的「Esc/Ctrl+C 取消当前轮」—— 那是二手
   * 转述,`zero.pause` 已经被查出把两个键的语义记反了。上面引的是厂商自己的键位表。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'Devin CLI 官方快捷键表(Input):Esc = "Cancel running agent",Ctrl+D = '
      + '"Exit (when input is empty)" — '
      + 'https://docs.devin.ai/cli/reference/keyboard-shortcuts (取证 2026-08-24)',
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'devin',
    name: 'Devin',
    description:
      "Cognition's Devin for Terminal agent for local, interactive coding sessions with Devin Cloud integration.",
    websiteUrl: 'https://docs.devin.ai/cli',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['stop', 'notification'],
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:devin 只提供 `cli.devin.ai/install.sh`,没有带校验的版本化归档。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({ binaryNames: ['devin'] }),
    /**
     * agent memory —— Devin CLI **自己会去读**的规则文件。
     *
     * 出处:https://docs.devin.ai/cli/extensibility/rules(取证 2026-08-24)。该页列出的位置里,
     * 项目侧有 `AGENTS.md`(recommended)、`AGENTS.local.md`、`AGENT.md`、`CLAUDE.md`、
     * `.devin/rules/*.md`、`.devin/global_rules.md`、以及 `.windsurf/**` 与 `.cursor/rules/**`
     * 两套 legacy;用户侧有 `~/.config/devin/AGENTS.md`、`~/.devin/rules/*.md`、
     * `~/.devin/global_rules.md`、`~/.claude/CLAUDE.md`。
     *
     * ⚠️ 只登记其中六条,其余是有意留白:
     *  · ❌ `CLAUDE.md` / `~/.claude/CLAUDE.md` / `.cursor/rules` / `.windsurf/**` —— 别家的
     *    专名文件,登给 devin 会让同一份文件在多家的读数里重复出现,分不清是谁的记忆;
     *  · ❌ `AGENTS.local.md` / `AGENT.md` —— 同一条约定的变体,收进来只会让读数里出现同一段
     *    内容的多份副本。
     * ⚠️ 引擎会在子目录里惰性发现规则,而 `AgentMemoryEntry` 的 directory 形态只收顶层 ——
     * 子目录规则读不回来,是已知欠账。
     * ⚠️ Windows 上的用户侧路径是 `%APPDATA%\devin\AGENTS.md`,与这里登记的
     * `~/.config/devin/AGENTS.md` 不同 —— 宿主那把 fs 恒锚在 home,声明里表达不了平台分叉,
     * Windows 上 global 那条会读到空。已知欠账,不是错登记。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.config/devin/AGENTS.md' },
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.devin/global_rules.md' },
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.devin/rules',
          suffixes: ['.md'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.devin/global_rules.md' },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.devin/rules',
          suffixes: ['.md'],
        },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'argv',
      flag: '--',
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
    args: ['acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--permission-mode=bypass',
        initialPromptFlag: '--',
        resumeFlag: '--continue',
      }),
  },
  hooks: buildDevinHookConfig(),
});
