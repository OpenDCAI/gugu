import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import { buildStandardCommand, recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';
import { buildCursorTrustBehavior } from './trust';
import { CURSOR_PERMISSION_MODES } from './permission-modes';
import {
  cursorSessionBundleBehavior,
  cursorSessionBundleDescriptor,
} from './session-bundle';
import { cursorMcpAdapter } from './mcp';

export const plugin = definePlugin(
  {
    id: 'cursor',
    name: 'Cursor',
    description:
      "Cursor's agent CLI; provides editor-style, project-aware assistance from the shell.",
    websiteUrl: 'https://cursor.com/docs/cli/overview',
  },
  {
    sessionBundle: cursorSessionBundleDescriptor,
    /**
     * Cursor 的 ACP/headless turn 依赖厂商登录。mac1 2026-09-02 的 GUI/keychain
     * GUI bootstrap 阳控已确认 login keychain 可读，status 与固定 prompt 均成功；
     * 真实 ACP 回路仍需在同一 GUI 域继续测量，不能把结构握手当作免账号。
     */
    vendorAccount: {
      kind: 'required',
      evidence:
        'mac1 2026-09-02 GUI 域(launchctl bootstrap gui/501)：status 已登录、固定 prompt 回 CURSOR-OK；无 Cursor 账号时 status 直接要求登录 ⇒ required。读数依赖 mac1 既存登录，token 有效期为止。',
    },
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
      modes: CURSOR_PERMISSION_MODES,
      modesExhaustive: true,
    },
    // 只认不装:cursor 只提供 `cursor.com/install` 这个安装脚本,没有带校验的版本化归档。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({
      binaryNames: ['cursor-agent'],
      installDocs: 'https://cursor.com/docs/cli/installation',
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    /**
     * agent memory —— Cursor **自己会去读**的规则文件。
     *
     * 出处:https://cursor.com/docs/context/rules(取证 2026-08-24)原文
     *  · "Project rules live in `.cursor/rules` as `.mdc` files and are version-controlled."
     *  · "A plain `.md` file in `.cursor/rules` is ignored by the rules system because it has no
     *    frontmatter to specify `description`, `globs`, and `alwaysApply`."
     *  · AGENTS.md:"Place it in your project root as an alternative to `.cursor/rules` for
     *    straightforward use cases."
     *
     * ⚠️ `suffixes` **必须**只有 `.mdc`:同一个目录里的 `.md` 被引擎忽略,把它收进来就是把
     * 「不是记忆的东西」当记忆读回去(README、备份稿都常年住在这个目录里)。
     * ⚠️ 引擎支持子目录(文档的例子就是 `.cursor/rules/frontend/components.mdc`),而
     * `AgentMemoryEntry` 的 directory 形态只收顶层 —— 子目录规则读不回来,是已知欠账。
     * ⚠️ ❌ 不登记 global:Cursor 的 User Rules 存在设置界面(Customize → Rules),官方文档
     * **没有**给出任何磁盘路径。猜一个路径的后果是静默读到空,宁可留欠账。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.cursor/rules',
          suffixes: ['.mdc'],
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
    trust: {
      kind: 'supported',
      // 写用户那份全局配置(见 capabilities/trust.ts 的 channel 注释)—— 沿用,未查运行时通道。
      channel: 'config-file',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: cursorSessionBundleBehavior,
  acp: createNativeAcpBehavior(() => ({
    args: ['acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '-f --approve-mcps',
        // TUI command-shape only (cursor-agent --help, 2026.08.31-4057e58):
        // `--plan Start in plan mode (shorthand for --mode=plan)` and
        // `--mode <mode> ... choices: "plan", "ask"`. TUI behavior remains
        // unmeasured and the descriptor keeps tui none/none.
        planFlag: '--plan',
        readOnlyFlag: '--mode ask',
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
  mcp: cursorMcpAdapter(),
  trust: buildCursorTrustBehavior(),
});

export {
  CURSOR_ACP_SOURCE,
  CURSOR_ACP_VERSION,
  cursorSessionBundleBehavior,
  cursorSessionBundleDescriptor,
} from './session-bundle';
