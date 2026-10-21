import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import { recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { requireBridgeEntry } from '../../helpers/acp-bridge-entry';
import { resolveNodeInterpreter, type NodeVersionRequirement } from '../../helpers/node-interpreter';
import { ZCODE_PERMISSION_MODES } from './permission-modes';
import { icon } from './icon';
import { materializeZcodeSessionBundle, zcodeSessionBundleDescriptor } from './session-bundle';

/**
 * 跑桥与 ZCode 后端的 Node:ZCode 仓根 `package.json` 的 `engines.node` 是 `>=24.0.0`(mise 钉 24.14.0),
 * 后端要用 `node:sqlite`;桥(zcode-acp-server)自己声明 `node >=22`。取两者中严的那个。
 */
const NODE_FOR_ZCODE: NodeVersionRequirement = { major: 24, minor: 0 };

/**
 * ZCode 的 CLI 随桌面 app 发,不上 PATH:它是 app 包里的 `resources/glm/zcode.cjs`,桌面端自己用 Electron
 * 的 Node(`ELECTRON_RUN_AS_NODE=1`)跑它。位置出自厂商安装包本身(ZCode 3.15.3):
 *  · macOS:dmg 里 `ZCode.app/Contents/Resources/glm/zcode.cjs`,拖进 /Applications(2026-10-17 mac1 挂载读到);
 *  · Linux:deb 落 `/opt/ZCode/resources/glm/zcode.cjs`(`dpkg-deb -c` 读到;rpm 同一个 electron-builder 布局);
 *    AppImage 没有固定位置,由用户手动指定;
 *  · Windows:electron-builder NSIS 的按用户安装位置 `%LOCALAPPDATA%\Programs\ZCode`(未实测,与 zcode-acp
 *    README 列的位置一致)。
 * PATH 上的 `zcode`(官方 `build:zcode` 发行包或社区 zcode-app-cli 装出来的那个命令)先认。
 *
 * `skipVersionProbe`:它是一份要解释器来跑的脚本,直接执行就得靠用户 PATH 上恰好有一个够新的 node
 * (Windows 上根本执行不了)。咕咕不在探测时跑它;运行时由咕咕交给桥的 Node 来跑(见下方 `buildSpawn`)。
 */
const zcodeDependency = recognisedDependency({
  binaryNames: ['zcode'],
  knownPaths: {
    macos: ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', '~/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'],
    linux: ['/opt/ZCode/resources/glm/zcode.cjs'],
    windows: ['%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs'],
  },
  skipVersionProbe: true,
  installDocs: 'https://zcode.z.ai/en/docs/install',
});

/**
 * ZCode 读的记忆文件:从工作目录往上到项目根的 `AGENTS.md`,加上 ZCode 数据根的 `~/.zcode/AGENTS.md`
 * (zai-org/ZCode `apps/zcode-cli/packages/adapters/src/context/index.ts`)。`CLAUDE.md` 它不读。
 * ⚠️ 项目层是向上走的,咕咕只读工作区根那一份。
 */
const zcodeMemory = {
  kind: 'files',
  entries: [
    { kind: 'file', scope: 'global', channel: 'agents-md', path: '.zcode/AGENTS.md' },
    { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
  ],
} satisfies AgentMemoryDescriptor;

export const plugin = definePlugin(
  {
    id: 'zcode',
    name: 'ZCode',
    description: 'Zhipu ZCode coding agent, driven through its own app-server protocol by an ACP bridge.',
    websiteUrl: 'https://zcode.z.ai',
  },
  {
    sessionBundle: zcodeSessionBundleDescriptor,
    /**
     * 思考档 = 桥报的 configOption `thought`(category `thought_level`)的取值,逐字:low / high / max
     * (`session/new` 实测;GLM-5.3 的推理档就是这三档,不能关)。
     */
    effort: {
      kind: 'selectable',
      effortOptions: {
        low: { name: '低', description: '快速回应，推理较浅' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        max: { name: '最高', description: '最深的推理，适合疑难问题' },
      },
    },
    acp: {
      kind: 'supported',
      /**
       * 三维都走 `session/set_config_option`(桥报 `model` / `mode` / `thought` 三个 configOption),
       * 应答带回新的 `currentValue`(实测 `mode=build` → 读回 `build`)⇒ `ack-read-back`。
       * 忙时一律 `reject`:运行中改配置在 app-server 里「影响下一轮」,这一层没量过,❌ 先声明更松的。
       */
      liveSettings: {
        model: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
        permission: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
        effort: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
      },
    },
    autoApprove: {
      kind: 'supported',
      modes: ZCODE_PERMISSION_MODES,
      modesExhaustive: true,
    },
    hostDependency: zcodeDependency,
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: {
        kind: 'listed',
        prefix: 'mcp__gugu__',
        evidence: 'session/create.mcpServers 挂名为 gugu 的 stdio server,工具行 toolName = mcp__gugu__gugu_secret_word'
          + '(ZCode 3.15.3 app-server;gugu-base notes/2026-10-16-zcode-harness/实测-app-server-ACP桥可行性.md)',
      },
    },
    memory: zcodeMemory,
    trust: { kind: 'none' },
    // 终端腿不开(见 session-bundle 的 `surfaces`),这一格只是如实说明为什么没有首句通道。
    prompt: {
      kind: 'none',
      reason: 'Gugu offers ZCode only as a Work (ACP) session; ZCode has not published a CLI with its terminal UI.',
    },
    // 会话由 ZCode 自己存(CLI 的会话库),桥报 loadSession / list / resume。
    // fork 不声明:桥报了 `sessionCapabilities.fork`,但咕咕这条腿的 fork 适配器没量过,❌ 先声明再说。
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeZcodeSessionBundle, platformModel },
  acp: {
    // 咕咕维护的构建 @gugu-acp/zcode-acp(上游 william0wang/zcode-acp + 补丁,shuxueshuxue/gugu-acp
    // `bridges/zcode-acp/`),按别名装在 zcode-acp-server 下;入口由宿主解析(#6394),暂不按 CLI 版本配对。
    bridge: { kind: 'package', alias: 'zcode-acp-server', entry: 'dist/cli.js' },
    buildSpawn: (ctx) => {
      const node = resolveNodeInterpreter({ require: NODE_FOR_ZCODE, purpose: 'ZCode 的 ACP 桥与后端' }).command;
      return {
        command: node,
        args: [requireBridgeEntry(ctx, 'zcode')],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          // ⚠️ **必须钉**:桥自己会按 ZCODE_BIN → PATH → 桌面包的顺序找 CLI,不钉就可能跑到用户机器上
          //    另一份 zcode,与咕咕探测、展示的那份对不上。
          ZCODE_BIN: ctx.cli,
          // 后端与桥用同一个 Node:与 ZCode 桌面端一样,用宿主自带的那份(Electron 时配 ELECTRON_RUN_AS_NODE),
          // ❌ 依赖用户 PATH 上恰好有一个 node。
          ZCODE_NODE: node,
          // 桥发现有 Bun ≥1.4 会把自己换成 bun 跑;钉回 node,运行时只有咕咕选的这一种。
          ZCODE_ACP_RUNTIME: 'node',
        },
      };
    },
    connect: (io, toClient) => connectStdioAcp(io, toClient),
  },
});

export { materializeZcodeSessionBundle, zcodeSessionBundleDescriptor } from './session-bundle';
