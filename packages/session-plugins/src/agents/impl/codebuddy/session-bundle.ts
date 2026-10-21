import { harnessPlatform } from './platform';
import { platformModel } from './platform-model';
import type {
  Degradation,
  NativeHome,
  GeneratedArtifact,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionMcpServer,
} from '@gugu/session-core/agents/plugins';
import { sessionPromptText, sessionRunHome } from '../../helpers/session-bundle';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpProtocolServers,
  sessionMcpStdioEnv,
} from '../../helpers/session-mcp';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CodeBuddy Code(`@tencent-ai/codebuddy-code`)的会话包。一手出处:发行包 2.169.0 的
 * `dist/codebuddy.js`(`npm pack` 解开)与 mac1 上的实测,读数在
 * gugu-base `notes/2026-10-19-codebuddy-harness/`(下文「实测 X」都指那份读数)。
 */
const VERSION = '2.169.0';

const autonomyOutsideBundle: Degradation = {
  code: 'unsupported-channel',
  reason:
    'CodeBuddy autonomy is selected by the host permission channel (ACP session/set_mode, '
    + 'TUI --permission-mode), outside this bundle.',
};
const unverifiedExtension: Degradation = {
  code: 'unverified',
  reason: `CodeBuddy Code v${VERSION} extension delivery has not been verified.`,
};

const SETTINGS_FILE = 'gugu-session-settings.json';
const MCP_CONFIG_FILE = 'gugu-session-mcp.json';

export const codebuddySessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: {
    envVar: 'CODEBUDDY_CONFIG_DIR',
    userPath: '.codebuddy',
    evidence: '@tencent-ai/codebuddy-code 2.169.0 dist/codebuddy.js `getUserConfigPath`:CODEBUDDY_CONFIG_DIR 挪走配置根,默认 ~/.codebuddy;官方 env-vars 文档同',
  } satisfies NativeHome,
  platform: harnessPlatform,
  credentialLifecycle: {
    'acp': {
      delivery: 'process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
    'tui': {
      delivery: 'process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': { identity: 'addressable', messageTransport: 'router' },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
  },
  units: {
    /**
     * ACP 腿:`session/new.mcpServers`(实测 F:stdio server 被拉起、`mcp__echo__echo` 调通)。
     * 咕咕自己那几台(`alwaysLoad`)带 `_meta.defer_loading: false`:CodeBuddy 默认把 MCP 工具藏在
     * `ToolSearch` 后面(实测 E),而 `convertAcpMcpServersToDynamic` 把条目 `_meta.defer_loading`
     * 原样读成这台 server 的开关(`isToolDeferLoadingWithOverlay` 先看它)⇒ 与 Claude 的
     * `alwaysLoad`、qwen 的 `alwaysLoadTools` 是同一件事在这一家的原生写法。
     *
     * 终端腿:run-scoped 0600 文件 + `--mcp-config <路径>`(不带 `--strict-mcp-config`,用户自己的
     * server 照常加载)。条目里的 `${VAR}` 由它自己的 MCP 配置展开器在子进程环境里解析
     * (`expandStdioConfig` / `expandUrlConfig`),令牌的值因此不落盘。
     */
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        'tui': { kind: 'native', channel: 'config-file-argv' },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    /**
     * 平台模型 → 咕咕自己目录里的一份 0600 settings 文档(`env` 块),`--settings <路径>` 指过去。
     * 只靠进程环境不够:用户 `~/.codebuddy/settings.json` 的 `env` 块压得住进程环境(实测 G),
     * `--settings` 那一层压得住它(实测 H)。
     */
    model: { kind: 'native', channel: 'config-file' },
    autonomy: { kind: 'none', degraded: autonomyOutsideBundle },
    /**
     * ACP 腿走 ③ `session-context`:厂商原生 ACP server 不读 `_meta.systemPrompt.append`。
     * 终端腿走 `--append-system-prompt <正文>`(追加,原基座一字不动;`--acp` 下同样生效,实测 I),
     * 与 qwen 终端腿同一个通道。
     */
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        'tui': { kind: 'native', channel: 'argv-append' },
      },
    },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  coexistence: {
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    introspection: { kind: 'native', channel: 'config-scan' },
    memory: { kind: 'native', channel: 'vendor-file' },
  },
} satisfies SessionBundleDescriptor;

/** 咕咕那几台(`alwaysLoad`)不进 ToolSearch —— CodeBuddy 自己的 server 级开关。 */
function deferMeta(server: SessionMcpServer): { _meta?: { defer_loading: false } } {
  return server.alwaysLoad ? { _meta: { defer_loading: false } } : {};
}

/** 终端腿的 `--mcp-config` 文档:值一律是 `${VAR}` 引用,真值只在子进程环境。 */
function processMcpConfig(bundle: SessionCapabilityBundle): string {
  return `${JSON.stringify({
    mcpServers: Object.fromEntries(bundle.mcpServers.map((server) => {
      if (server.transport === 'stdio') {
        assertSessionMcpStdioEnv(server, bundle, 'CodeBuddy');
        return [server.name, {
          type: 'stdio',
          command: server.command,
          args: [...(server.args ?? [])],
          ...(server.env ? { env: sessionMcpStdioEnv(server) } : {}),
          ...(server.cwd ? { cwd: server.cwd } : {}),
          ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
        }];
      }
      sessionMcpAuthorization(server, bundle.env, 'CodeBuddy');
      return [server.name, {
        type: 'http',
        url: server.url,
        ...(server.authorizationEnv ? { headers: { Authorization: `\${${server.authorizationEnv}}` } } : {}),
        ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
      }];
    })),
  }, null, 2)}\n`;
}

/**
 * 平台模型 → settings 文档的 `env` 块(映射本身只在 `platformModel.load` 一处)。
 *
 * ⚠️ 这次注入不成立就返回 null,一个字段都不发(与 qoder / qwen 同一条纪律):半套字段会让它照常起
 *    会话、用的却是用户自己的账号,而界面写着咕咕的模型。
 */
function platformSettingsEnv(bundle: SessionCapabilityBundle): Record<string, string> | null {
  const model = bundle.model;
  if (!model) return null;
  if (model.dialect !== harnessPlatform.dialect) {
    throw new Error(`CodeBuddy session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const env = platformModel.load(model).spawnEnv;
  return env && Object.keys(env).length > 0 ? (env as Record<string, string>) : null;
}

export function materializeCodebuddySessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface !== 'acp' && ctx.surface !== 'tui') {
    throw new Error(`CodeBuddy session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const argsAppend: string[] = [];
  const artifacts: GeneratedArtifact[] = [];
  let runHome: string | undefined;
  const runFile = (name: string) => join((runHome ??= sessionRunHome(bundle, 'CodeBuddy', 'codebuddy-capability-runs')), name);

  const settingsEnv = platformSettingsEnv(bundle);
  /**
   * 终端腿:这条会话的工作目录按次标成可信,只进这份会话文档(与 codex 的 `codexProjectTrustArgs` 同一个做法)。
   * 不给的话 TUI 起来先停在它自己的「Do you trust the files in this folder?」上(启动守卫 `AppStartupGuard`
   * 的 `DIRECTORY_TRUST_REQUIRED`,判据 `needsAuthorization(getWorkDir())` 只看 `trustAll` / `trustedDirectories`),
   * 首句卡在门外;它没有跳过这道门的旗标或 env。`--settings` 只收一个值,所以和模型写在同一份文档里。
   * ⚠️ 必须是 realpath:它拿 `process.cwd()` 比对,mac1 实测 `/tmp/…` 写法照样弹门,`/private/tmp/…` 不弹;
   *    两种写法都不写用户的 settings.json。ACP 腿不过这道门(`--acp` 不走启动守卫)。
   */
  /**
   * 令牌走进程环境,地址与模型留在文档里:CodeBuddy 把它加载的每份 settings 文档整份打进
   * `~/.codebuddy/logs/<日期>/*.log`(0644),进程环境不打(mac1 实测:同一个标记值放文档里命中 2 行,
   * 只放进程环境 0 行)。用户 settings.json 的 `env` 也写了 `CODEBUDDY_API_KEY` 时照样是我们的令牌到网关:
   * 带着 `--settings` 起的进程,进程环境压过用户 env(mac1 ACP 实测,假网关只认标记:不带 `--settings` 到的是
   * 用户的,带上之后到的是进程环境的;阳控臂里用户 env 只写 base URL,请求照它走,证明那份文件确实被读了)。
   */
  const { CODEBUDDY_API_KEY: platformKey, ...settingsDocEnv } = settingsEnv ?? {};
  if (platformKey) env.CODEBUDDY_API_KEY = platformKey;
  const settings = {
    ...(settingsEnv ? { env: settingsDocEnv } : {}),
    ...(ctx.surface === 'tui' ? { trustedDirectories: [realpathSync(ctx.cwd)] } : {}),
  };
  if (Object.keys(settings).length > 0) {
    const path = runFile(SETTINGS_FILE);
    // 传**路径**不传内联 JSON:进程表人人可读。0600 是因为里面有用户的工作目录与咕咕网关地址。
    artifacts.push({ path, content: `${JSON.stringify(settings, null, 2)}\n`, mode: 0o600 });
    argsAppend.push('--settings', path);
  }

  const prompt = sessionPromptText(bundle.promptBlocks);
  let acp: SessionMaterialization['acp'];
  let acpPrompt: SessionMaterialization['prompt'];
  if (ctx.surface === 'acp') {
    acp = { mcpServers: sessionMcpProtocolServers(bundle, 'CodeBuddy', deferMeta) };
    // 令牌随 ACP 条目的 header 走,不再留在适配器进程环境里。
    for (const server of bundle.mcpServers) {
      if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
    }
    // ⚠️ `carrier` 必须显式写出来:缺席 = 静默回落系统位(`_meta.systemPrompt.append`),对厂商原生
    //    ACP server 是黑洞。
    if (prompt) acpPrompt = { ...prompt, carrier: 'session-context' };
  } else {
    if (bundle.mcpServers.length > 0) {
      const path = runFile(MCP_CONFIG_FILE);
      artifacts.push({ path, content: processMcpConfig(bundle), mode: 0o600 });
      argsAppend.push('--mcp-config', path);
    }
    if (prompt) argsAppend.push('--append-system-prompt', prompt.value);
    /**
     * 主 agent 钉成 `cli`,与 ACP 腿同一个。终端里它自己的默认是 `ptc`(新装、没有 lastUsed 时即如此):
     * 那个模式的提示让模型经 REPL 调工具,而 REPL 目录只收**延迟加载**的工具(`listDeferredToolInfosForSession`),
     * 咕咕那几台是 `alwaysLoad`、只在直调的工具表上 ⇒ 模型一走 REPL 就是「Available on this server: (none)」。
     * mac1 实测同一句话两次里一次这样失败。`--agent` 只管这个进程的新会话、不写用户设置(`--help` 原文);
     * 用户在终端里照样能 `/agent-mode` 换。
     */
    argsAppend.push('--agent', 'cli');
  }

  const loaded = { status: 'loaded' as const };
  return {
    argsAppend,
    env,
    ...(acp ? { acp } : {}),
    ...(acpPrompt ? { prompt: acpPrompt } : {}),
    configMerges: [],
    artifacts,
    report: {
      adapterId: 'codebuddy',
      surface: ctx.surface,
      units: {
        mcp: bundle.mcpServers.length > 0
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No MCP server was declared.' } },
        env: loaded,
        model: settingsEnv
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No platform model was declared.' } },
        autonomy: { status: 'degraded', reason: autonomyOutsideBundle },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were declared.' } },
        packages: { status: 'degraded', reason: unverifiedExtension },
      },
      discoveredCommands: [],
    },
  };
}
