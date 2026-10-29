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
  /**
   * TUI 腿的中断键 —— **Esc,连按两次**。
   *
   * ⚠️ 这里绝不能填 Ctrl-C,尽管它看起来更像「中断」:zero 的 Ctrl-C 第一下 `cancelRun()` **顺带**
   * 武装退出确认,3 秒内的第二下直接 `m.quit()` 退进程
   * (`internal/tui/model.go` 的 `ctrlCExitConfirmDuration = 3 * time.Second` /
   * `ctrlCExitConfirmText = "Press Ctrl+C again to exit"`,以及 handler 里
   * `if m.exitConfirmActive { … m.exiting = true; return m.quit() }`)。它自己的帮助层把这条写成
   * 「Ctrl+C — cancel the run, then quit」。宿主的中断是**暂停**(进程活着、会话还在),
   * 用 Ctrl-C 就会变成「点了暂停,会话没了」。
   *
   * Esc 这条相反,只取消本轮、永不退进程:同文件 `escCancelConfirmDuration = 3 * time.Second` /
   * `escCancelConfirmText = "Press Esc again to cancel"`,Esc 分支末尾
   * `if m.pending { if wasConfirmingCancel { m.clearComposer(); m.cancelRun(); … } }` ——
   * 第一下只武装确认,第二下才真取消。帮助层同源:`internal/tui/keybinding_help.go`
   * `{"Esc (×2)", "cancel the run / dismiss a popup / clear the input"}`。
   *
   * `intervalMs` 取 300ms:必须 < 3000ms 的确认窗口(超时就白按),又必须显著大于终端把连续两个
   * ESC 字节并成一次 Alt 前缀的阈值。
   *
   * ⚠️ 已知边界:Esc 在 zero 里被重载得很厉害(子会话退出、文件详情退出、权限/问话弹层、
   * picker、建议浮层、已选文件、排队消息…),前面任一层吃掉这一下,就要多按一轮才轮到取消本轮。
   * 代价只是「没停下」,不会误杀 —— 这正是选 Esc 不选 Ctrl-C 的理由。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    presses: 2,
    intervalMs: 300,
    evidence:
      'Gitlawb/zero@ad34dc8d81daa6e2c171df4c237b14aff8561ff9 internal/tui/model.go '
      + '(escCancelConfirmDuration / escCancelConfirmText / Esc 分支的 wasConfirmingCancel → cancelRun) '
      + '与 internal/tui/keybinding_help.go 的 "Esc (×2) — cancel the run";'
      + 'Ctrl+C 同文件是 "cancel the run, then quit"(第二下 m.quit())故不取。核对日期 2026-08-24。',
  },
  /**
   * 八维里接通两条(pause / memory),其余六条落回 `BASE_SESSION_COEXISTENCE`。逐条说明:
   *
   * · `observability` —— TUI 腿唯一的读侧通道是 hook 回传链,而本插件 `hooks` 能力是缺省的
   *   `kind: 'none'`(本文件没声明 hooks,也没有 hooks.ts)→ `ensureHooksInstalled` 两条分支
   *   都不走,`GUGU_HOOK_*` 没有消费者。⚠️ zero 厂商侧**是有** hooks 的
   *   (`internal/hooks/hooks.go`),所以这条是咕咕的欠账、不是 zero 的缺陷。
   *
   * · `askUser` —— TUI-only 的家一律不成立:去程只有一个布尔 notification_type,回程 `sendInput`
   *   写的是终端而不是某个待决请求(理由与出处见 session-core/.../tui-coexistence.ts 末尾)。
   *   ⚠️ zero 自己有 `pendingAskUser`(model.go)与 `internal/acp/permission.go`,但咕咕没接它的
   *   ACP 腿(本文件没有 `provider.acp`,surfaces 只有 tui)。
   *
   * · `introspection` —— 没有 `provider.mcp`,`readServers` 无处可扫。
   *
   * · `todo` —— 归一化的 ACP `plan` 更新只走 ACP 腿,咕咕没接 zero 的 ACP 腿。
   *
   * · `history` —— core 的 `transcriptSources/` 注册表当前只有 claude-code 与 codex 两份 spec。
   *
   * 这些都是「咕咕还没接」,不是「zero 做不到」。
   */
  coexistence: {
    /**
     * 由上面那把中断键兑现。⚠️ 别手写这个字面量 —— 主干改了通道名要跟着走,
     * 须与 `tuiPauseFromInterrupt()` 的返回值一致。
     */
    pause: TUI_INTERRUPT_PAUSE,
    /**
     * 咕咕经 `AgentPluginHost.readMemoryFiles`(session-core/.../plugin-host.ts:270)读得到 zero
     * 自己会去读的那几个文件 —— 具体登记在下面的 `capabilities.memory`,通道 `agents-md`
     * (每个目录里 zero 先看 AGENTS.md,ZERO.md 是它的次选与个人级专名文件)。
     * 厂商出处:https://github.com/Gitlawb/zero README「Project guidance」一节。
     * ⚠️ 两处必须同通道。
     */
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'zero',
    name: 'Zero',
    description:
      'Terminal coding agent with multi-provider model support, local-first configuration, and terminal-first coding workflows.',
    websiteUrl: 'https://zero.gitlawb.com/',
  },
  {
    sessionBundle,
    autoApprove: {
      kind: 'supported',
    },
    // 托管安装(npm backend):bin 是 JS(`bin/zero.js`),它的平台包装的是 `agent-browser`
    // 这类辅助件 —— 作为 optionalDependencies 由 aube 一并装好,正是 npm 装法的形状。
    // (2026-08 那条「npmmirror 还停在老启动器版」的注记不再是装法判据:镜像落后与否由源菜单
    //  逐个现查,装的是那个源上的那个版本。)
    // `versionLine`:`--version` 里它自己那一行,实测原样「zero 0.10.0」(包装器的 banner 在它前面)。
    hostDependency: { ...miseDependency({
      id: 'zero',
      backend: 'npm',
      package: '@gitlawb/zero',
      node: MANAGED_NODE_VERSION,
    }), versionLine: /^zero / },
    // agent memory —— zero 项目级收 AGENTS.md 系,个人级用自己的专名文件 ZERO.md。
    // 出处:官方仓 README(https://github.com/Gitlawb/zero)的 Project guidance 一段:
    //  ·「Zero appends project-specific guidance to the system prompt from the first `AGENTS.md`,
    //     `ZERO.md`, or `.zero/AGENTS.md` file found in each directory from the git root down to
    //     your current working directory (checked in that order per directory).」
    //  ·「A personal `ZERO.md` under `config.UserConfigDir()/zero/ZERO.md`
    //     (`$XDG_CONFIG_HOME/zero/ZERO.md` or `~/.config/zero/ZERO.md` on Linux/macOS …)」
    // ⚠️ 项目那三条在 zero 那边是**每目录取第一个**,不是并列全读;这里三条都登记,是因为咕咕
    //    这一侧读的是「zero 可能会读的文件」,而一个仓里通常只存在其中一个。多读一个不会误导,
    //    漏登记才会让界面把用户写过的记忆报成空。
    // ⚠️ global 那条按文档默认值锚在 `~/.config`:zero 的 `internal/config/paths.go` 里
    //    `UserConfigDir()` 在 macOS 上**故意**不用 Go 默认的 ~/Library/Application Support,
    //    而是 ~/.config。用户显式设了 XDG_CONFIG_HOME(或在 Windows 上)时这条读到空 ——
    //    那是「声明了但磁盘上没有」,与用户没写过表现一致,不会读错别人的文件。
    //    ❌ 也不能改成绝对路径:`AgentMemoryEntry.path` 一律相对作用域根,越界会被 resolveSafe 抛异常。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.config/zero/ZERO.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'ZERO.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: '.zero/AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'keystroke',
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
        autoApproveFlag: '--skip-permissions-unsafe',
      }),
  },
});
