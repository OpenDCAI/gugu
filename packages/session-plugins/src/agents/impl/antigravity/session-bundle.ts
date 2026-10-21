import {
  randomUUID,
} from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  join,
} from 'node:path';
import type {
  Degradation,
  GeneratedArtifact,
  JsonOverlay,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionPromptBlocks,
} from '@gugu/session-core/agents/plugins';
import { agentHomeSegments } from '@gugu/session-core/agents/plugins';
import {
  sessionMcpAuthorization,
  sessionMcpProtocolServers,
} from '../../helpers/session-mcp';
import { sessionContextPrompt } from '../../helpers/session-bundle';

/**
 * 本文件每一格的读数底座:2026-09-23 MBP 对 Google 官方 ACP 服务 `agy_acp_server` 1.1.1
 * (ACP 注册表 `antigravity-acp`,initialize 自报 `agentInfo.version = agy_acp_server_1.1.1`)
 * 的真机探针 —— 隔离 `$GEMINI_HOME`(一次性目录)+ 本地假 Gemini 线端点
 * (`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>`)+ 本地假 MCP server,零真实推理、零 Google 账号。
 * 形状照 gemini(#4655)那一份:每格带变异或行为对照。
 */
export const ANTIGRAVITY_ACP_VERSION = '1.1.1';

/**
 * 自治档不走物化:聊天面板腿经 ACP `session/set_mode` 在运行期下发,终端腿由 `buildCommand` 按同一张档位表
 * 落成 argv(`--dangerously-skip-permissions` / `--mode accept-edits`;只读不在终端腿),
 * 见 `capabilities.autoApprove.modes` 与 index.ts。
 */
const autonomyViaAcpModes: Degradation = {
  code: 'unverified',
  reason:
    'Antigravity autonomy is delivered at runtime through ACP session/set_mode (chat leg) and the buildCommand '
    + 'permission argv (terminal leg) from the autoApprove.modes ladder, not through session materialization.',
};

/**
 * 咕咕的平台模型**点不了名** —— 这是量出来的终局,不是「还没查」。三条读数(2026-09-23):
 *  · 模型只能从它**自己的目录**里挑:`session/set_config_option {configId:'model', value:'gugu-alias-cfg'}`
 *    与 `session/set_model {modelId:'gugu-alias-setmodel'}` 都回 `-32602 "Model '…' is not available for
 *    the current authentication method."`,并附它认的那张表(`gemini-3.7-flash-high` … `gemini-3.1-pro-low`);
 *    目录内的 `gemini-3.1-pro-low` 则收下,线上请求随之变成 `/v1beta/models/gemini-3.1-pro-preview:…`
 *    (阳控:通道本身是活的,只是名字不由咕咕定)。
 *  · `GEMINI_MODEL`(gemini-cli 的那个旋钮)**被忽略**:设成 `gugu-alias-env` 后线上仍是 `gemini-3.7-flash`。
 *  · 选定认证方式只有两条路 —— `$GEMINI_HOME/antigravity-acp/settings.json` 的 `auth.type`,或 ACP
 *    `authenticate`;光给 `GEMINI_API_KEY` 不算(stderr 原文「Environment-based auth selection has been
 *    removed … a bare GEMINI_API_KEY no longer select an auth method」)。而 `authenticate` 会把
 *    `auth.type` **写进**那份 settings.json(实测 authenticate(gemini-api-key) 后文件出现
 *    `{"auth":{"type":"gemini-api-key"}}`)—— 在用户真 home 上就是改写他的登录方式。
 * 再加上网关那一侧:New API 自带 Gemini 原生入口(预发/生产 `/v1beta/models/…:generateContent` 实测
 * 回 401 而非 404,2026-09-24),但咕咕没有 Gemini 原生上游(只有 GLM / OpenAI),而格式转换是禁止的
 * (#5824 之后只走原生)。⇒ 这一格如实记 `unsupported-channel`。
 * owner 2026-09-24 定性:「Antigravity 在咕咕里只能走订阅(用户自己的 Google 账号),自营网关走不了,
 * 这个我们客观承认」。❌ 别把这一家的 `platform` 改成 supported,除非网关先接了 Gemini 原生上游。
 */
const platformModelUnnameable: Degradation = {
  code: 'unsupported-channel',
  reason:
    `agy_acp_server ${ANTIGRAVITY_ACP_VERSION} only accepts model ids from its own catalog (set_config_option / `
    + 'set_model with any other id → -32602 "not available for the current authentication method"), ignores '
    + 'GEMINI_MODEL, and selects the API-key auth method only via settings.json auth.type or ACP authenticate '
    + '(which persists auth.type into $GEMINI_HOME). A Gugu platform alias cannot be named on this leg.',
};

const noExtension: Degradation = {
  code: 'unverified',
  reason: `agy_acp_server ${ANTIGRAVITY_ACP_VERSION} extension/plugin delivery has not been measured.`,
};

/**
 * 回环地址免代理 —— 递给**每一次** spawn(真会话与模型目录探针同一条 `buildSpawn`)。
 *
 * 读数(owner 侧 2026-09-23 MBP,系统 SOCKS 代理 127.0.0.1:7897 开着):`session/new` 回
 * `-32603 "python-socks is required to use a SOCKS proxy"` —— 它起会话时要连**自己的**本地 harness
 * (stderr `local_connection.py … RAW WS MSG`,一条回环 websocket),而这条连接被代理设置截走;
 * 子进程环境补 `NO_PROXY=127.0.0.1,localhost`(大小写两份)后同一台机器上通过。
 * ⚠️ 本 slice 在另一份 shell 环境里**没复现**那个失败(系统代理的 ExceptionsList 已含 127.0.0.1;
 *    显式加 `ALL_PROXY=socks5://127.0.0.1:7897` 也照样通),即触发条件依赖环境 —— 正因为如此才无条件带上:
 *    多带一条回环豁免没有任何代价,少带就是某些用户机器上会话起不来。
 * ⚠️ 合并而不是覆盖:用户自己的 `NO_PROXY` 一个条目都不许丢。
 */
export const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost'] as const;

export function withLoopbackNoProxy(env: Readonly<Record<string, string>>): Record<string, string> {
  const merged = (value: string | undefined) => {
    const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    for (const host of LOOPBACK_NO_PROXY) if (!entries.includes(host)) entries.push(host);
    return entries.join(',');
  };
  const existing = env.NO_PROXY ?? env.no_proxy;
  return { NO_PROXY: merged(existing), no_proxy: merged(env.no_proxy ?? existing) };
}

/**
 * 终端腿(`tui`)跑的 `agy` 版本读数底座:2026-09-24 MBP,agy 1.2.9(`~/.local/bin/agy`),
 * 影子 HOME + API key 模式(托管 `settings.json` 写 `{"modelProvider":"gemini"}`,`GEMINI_API_KEY` +
 * `GOOGLE_GEMINI_BASE_URL` 指本地假 Gemini 端点)+ 本地假 MCP,零 Google 账号、零真实推理。
 */
export const ANTIGRAVITY_CLI_VERSION = '1.2.9';

/**
 * 终端腿**只在 macOS / Linux 上开**。Windows 上如实关掉,聊天面板腿照常。
 *
 * ## 为什么 Windows 关
 *
 * 两条腿共用咕咕托管的**一份** `.gemini`(owner 原则:一个 harness 一个配置根)。聊天面板腿有
 * `GEMINI_HOME` 可以挪;`agy` 没有 —— 它的配置根只跟着**家目录**走(官方 CLI 文档 28 页无任何配置目录
 * 参数或环境变量;MBP 实测 `GEMINI_HOME` 对它无效,换 `HOME` 才生效)。POSIX 上咕咕只在 `agy` 这一个
 * 进程上换 `HOME`、再让它起的 shell 把真 HOME 换回来(`ANTIGRAVITY_HOME_RESTORE_*`,zsh / bash 两条实测)。
 * Windows 上家目录认的是 `USERPROFILE`,而 agent 跑命令用的 cmd / PowerShell 没有 `.zshenv` / `BASH_ENV`
 * 那样「每个 shell 起来先跑一段」的钩子可以把它换回来 —— 换了就是用户在终端里跑的每条命令都拿到一个假家
 * 目录(git 全局配置、`~` 下的文件全错位),不换就是 `agy` 读写用户真的 `%USERPROFILE%\.gemini`,
 * 咕咕的 MCP / 回合边界钩子一个都送不到。两头都不成立,且本机测不了 ⇒ 这条腿在 Windows 上不开,
 * ❌ 不上线一个会写用户真配置、或把 agent 命令的家目录弄错的版本。
 *
 * ⚠️ 与 `surfaces` / `sessionpage` / `sessionTuiInterrupt` 同一个开关(照 kimi 的 `KIMI_SESSION_TUI_ENABLED`):
 *    registry 拦「声明了 sessionpage 集成却没有那条 surface」。
 */
export const ANTIGRAVITY_SESSION_TUI_ENABLED = process.platform !== 'win32';

/**
 * 影子 home 里给 agent 的 shell 换回真 HOME 的两份文件(相对影子 home)。
 *
 * ## 为什么要换回来
 *
 * `agy` 起命令(`run_command`)用用户的 `$SHELL`,子进程继承它的环境 ⇒ 命令里 `HOME` 是影子 home,
 * git 读不到全局配置、`~` 下新建的文件落进咕咕的目录。换回来的办法是 shell **自己**在启动时跑的那段:
 *  · zsh:`$ZDOTDIR/.zshenv`(任何 zsh 都读,含 `zsh -c`)。启动器把 `ZDOTDIR` 指到影子 home,
 *    `.zshenv` 里先把 `HOME` / `ZDOTDIR` 还原,再 source 用户真正的 `.zshenv`;之后 zsh 按还原后的
 *    `ZDOTDIR` 去读 `.zprofile` / `.zshrc`,与用户平时一样。MBP 实测(zsh 5.9):命令里 `$HOME` 回到
 *    真实家目录、`git config --global` 读得到、`~` 下新建的文件落在真实家目录。
 *  · bash:非交互 bash 启动时 source `$BASH_ENV`(bash 手册 INVOCATION 一节)。同一个原理,
 *    还原后再 source 用户原来的 `BASH_ENV`(若有)。
 *  · 其余 shell(fish / nu …)**没覆盖**:它们的命令会拿到影子 HOME。如实记在这里,❌ 不声称全覆盖。
 *
 * ⚠️ 还原只在 `GUGU_AGY_REAL_HOME` 在场时做 —— 它只由咕咕的启动器(`ANTIGRAVITY_LAUNCH_SCRIPT`)设,
 *    用户自己在别处碰巧 source 到这份文件也什么都不发生。
 */
export const ANTIGRAVITY_HOME_RESTORE_ZSHENV = '.zshenv';
export const ANTIGRAVITY_HOME_RESTORE_BASH_ENV = '.gugu-restore-home.sh';

const RESTORE_HOME_BODY = [
  'if [ -n "${GUGU_AGY_REAL_HOME:-}" ]; then',
  '  export HOME="$GUGU_AGY_REAL_HOME"',
  '  if [ -n "${GUGU_AGY_REAL_ZDOTDIR+x}" ]; then export ZDOTDIR="$GUGU_AGY_REAL_ZDOTDIR"; else unset ZDOTDIR; fi',
  '  if [ -n "${GUGU_AGY_REAL_BASH_ENV+x}" ]; then export BASH_ENV="$GUGU_AGY_REAL_BASH_ENV"; else unset BASH_ENV; fi',
];

const ZSHENV_CONTENT = [
  '# 咕咕写的(Antigravity 终端腿):agy 只认 HOME 找 ~/.gemini,它起的 zsh 在这里把真 HOME 换回来,',
  '# 再读用户自己的 .zshenv。咕咕每次起会话都会重写这份文件;用户的 .zshenv 一个字节没动。',
  ...RESTORE_HOME_BODY,
  '  [ -r "${ZDOTDIR:-$HOME}/.zshenv" ] && . "${ZDOTDIR:-$HOME}/.zshenv"',
  'fi',
  '',
].join('\n');

const BASH_ENV_CONTENT = [
  '# 咕咕写的(Antigravity 终端腿):agy 起的非交互 bash 在这里把真 HOME 换回来,再读用户原来的 BASH_ENV。',
  ...RESTORE_HOME_BODY,
  '  if [ -n "${BASH_ENV:-}" ] && [ -r "$BASH_ENV" ]; then . "$BASH_ENV"; fi',
  'fi',
  '',
].join('\n');

/**
 * 终端腿的启动器 —— 由 `buildCommand` 包在 `agy` 外面(`/bin/sh -c <本段> <agy> <参数…>`)。
 *
 * ## 为什么换 HOME 要包在命令里,❌ 不放进 spawn 的环境变量
 *
 * 咕咕在 POSIX 上是经用户的 shell 起终端腿的(`$SHELL -c '<命令行>'`,tmux 打开时还要再过一层
 * tmux 里的 shell)。把 `HOME` 放进 spawn 环境,这些**外层** shell 也会拿到影子 HOME:它们会去读影子
 * home 的 `.zshenv` —— 那份文件正好会把 HOME 换回真的 ⇒ 到 `agy` 手里又是真 HOME,读写的是用户自己的
 * `~/.gemini`。换 HOME 必须只落在 `agy` 这**一个**进程上,也就是在命令行的最里层做。
 *
 * ## 影子 home 从哪来
 *
 * 不写死路径:两条腿都拿得到宿主算好的 `GEMINI_HOME`(`configRootEnv`,= `<影子 home>/.gemini`),
 * 去掉末尾的 `/.gemini` 就是影子 home —— 与 `resolveAgentHome` 的布局同一个事实,`buildCommand`
 * 保持纯函数。拿不到或形状不对就响亮失败,❌ 不回落用户真 HOME(那就是写用户的真配置)。
 *
 * ## macOS 钥匙串:影子 home 里要有一条 `Library/Keychains` → 真 home 的软链
 *
 * `agy` 的登录凭据在钥匙串里,它是经 `/usr/bin/security` 读写的(二进制里有
 * `find-generic-password` 与 `add-generic-password -U -s %s -a %s -w %s` 两串),而 `security` 找钥匙串
 * **跟着 HOME 走**(2026-09-24 MBP 实测):
 *  · `HOME=<空目录> security list-keychains` 只剩 `/Library/Keychains/System.keychain`,
 *    `default-keychain` 报「A default keychain could not be found」,已登录的那一项查不到(退出码 44);
 *  · 影子 home 里放 `Library/Keychains` → `$真HOME/Library/Keychains` 的软链后,默认钥匙串回到
 *    `~/Library/Keychains/login.keychain-db`,那一项查得到(0);在这个 HOME 下 `add-generic-password`
 *    写的一项,换回真 HOME 查得到(写进的就是用户的登录钥匙串)。
 * 没有这条软链,终端腿的 `agy` 看不见用户已有的登录、登完也存不下 —— 每次起来都要重新登录。
 * 只链这一个目录,真 home 一个字节不改;真 home 下没有这个目录(非 macOS)时什么都不做。
 * 已经是个**实体**目录(不是软链)时不动它 —— ❌ 不替别人删目录。
 */
export const ANTIGRAVITY_LAUNCH_SCRIPT = [
  'case "${GEMINI_HOME:-}" in */.gemini) ;; *) echo "gugu: GEMINI_HOME must point at the Gugu-managed .gemini (got \'${GEMINI_HOME:-}\')" >&2; exit 64;; esac',
  'shadow="${GEMINI_HOME%/.gemini}"',
  'if [ -d "$HOME/Library/Keychains" ] && { [ ! -d "$shadow/Library/Keychains" ] || [ -L "$shadow/Library/Keychains" ]; }; then',
  '  mkdir -p "$shadow/Library" && ln -sfn "$HOME/Library/Keychains" "$shadow/Library/Keychains"',
  'fi',
  'export GUGU_AGY_REAL_HOME="$HOME"',
  'if [ -n "${ZDOTDIR+x}" ]; then export GUGU_AGY_REAL_ZDOTDIR="$ZDOTDIR"; fi',
  'if [ -n "${BASH_ENV+x}" ]; then export GUGU_AGY_REAL_BASH_ENV="$BASH_ENV"; fi',
  `export HOME="$shadow" ZDOTDIR="$shadow" BASH_ENV="$shadow/${ANTIGRAVITY_HOME_RESTORE_BASH_ENV}"`,
  'exec "$0" "$@"',
].join('\n');

/**
 * 终端腿的 MCP 与 hooks 落点 —— 托管 `.gemini` 里的两份全局文件(两条腿共用同一份,见 `configRoot`)。
 *  · MCP:https://antigravity.google/docs/cli/mcp.md「Global server setups: Configured in
 *    `~/.gemini/config/mcp_config.json`」;形状照 `./mcp.ts`(HTTP 用 `serverUrl`、启用状态是 `disabled`)。
 *  · 首启向导:`antigravity-cli/cache/onboarding.json`(实测,见 `tuiOnboardingOverlay`)。
 */
const ANTIGRAVITY_MCP_CONFIG_REL = ['config', 'mcp_config.json'] as const;
const ANTIGRAVITY_ONBOARDING_REL = ['antigravity-cli', 'cache', 'onboarding.json'] as const;
const ANTIGRAVITY_CLI_SETTINGS_REL = 'antigravity-cli/settings.json';

/**
 * 终端腿的会话提示块载体:`agy` 的 PreInvocation 钩子读这个 env 指向的文件,原样打到 stdout
 * (钩子写入器见 ./hooks.ts)。文件内容就是官方钩子输出契约
 * `{"injectSteps":[{"ephemeralMessage":"…"}]}`(https://antigravity.google/docs/hooks#preinvocation)。
 * 钩子文件两条腿共用,会话事实只能走这次 spawn 的环境 —— 聊天面板腿起钩子时没有这个变量,什么都不打。
 */
export const ANTIGRAVITY_INVOCATION_CONTEXT_ENV = 'GUGU_AGY_INVOCATION_CONTEXT';

/**
 * Antigravity 两条腿是 Google 分开发行的**两个程序**(#6335,owner 拍板两条都要):
 *  聊天面板腿(`acp`)跑官方 ACP 服务 `agy_acp_server`;终端腿(`tui`,Windows 除外,见
 *  `ANTIGRAVITY_SESSION_TUI_ENABLED`)在 pty 里跑 `agy` CLI。两条腿共用咕咕托管的**同一份** `.gemini`。
 *  下面先是聊天面板腿的读数,终端腿各格的读数写在各自那一格上。
 *
 *  · **mcp / acp-session**:`session/new` 的 mcpServers ——
 *    http:`{type:'http', url, headers:[{name:'Authorization', value:'Bearer …'}]}` → 它依次调
 *    `server/discover` → `initialize` → `notifications/initialized` → `tools/list`,每次都带那个
 *    Authorization 头,注入的工具出现在下一次模型请求的 functionDeclarations 里(toolDeclared=true)。
 *    stdio:`{name, command, args, env:[{name:'GUGU_PROBE_TOKEN', value}]}` → 子进程拿到那个 env
 *    (假 server 记下 `tok-9911`),同一串 discover/initialize/initialized/tools/list,工具进模型请求体。
 *    ⚠️ initialize 自报 `mcpCapabilities:{http:true, sse:true}` 却没报 stdio —— 实测 stdio 照样通,
 *    以实测为准。
 *  · **env / child-process**:进程环境原样递进去(上面那条 stdio env、`GEMINI_HOME` 重定向配置根的
 *    日志「Gemini home resolved to … (from $GEMINI_HOME)」都是它的读数)。
 *  · **promptBlocks / session-context**:`session/prompt` 里带的 marker(`MARKER-PB-4412`)逐字进了
 *    模型请求体。没有系统位可坐 —— ❌ 不走 `_meta.systemPrompt.append`(原生 ACP server 收下即丢)。
 *  · **model**:见 `platformModelUnnameable`。用户**自己**的模型照常走 ACP 通用路径
 *    (`session/new` 的 `configOptions[category=model]` + `set_config_option`),那不占这一格。
 *  · **autonomy**:不占物化格,三档 modes 由 `session/new` 自报,运行期 `session/set_mode` 下发
 *    (读数见 `./permission-modes.ts` 的 `ANTIGRAVITY_PERMISSION_MODES`)。
 */
export const antigravitySessionBundleDescriptor = {
  /**
   * 托管配置根(#6335,owner 2026-09-24「行，你做吧」,照 Kimi 做)。举证(`AgentInjectionMode` 要求的
   * 「运行时通道递不进」):用户 skill / hook 只从 `$GEMINI_HOME` 下的目录读 —— ACP 服务的
   * `settings.json` 只认 `auth`/`gcp`(stderr「ignoring unknown key 'hooks' (accepted: auth, gcp)」),
   * `session/new` 的 `_meta` 收下即丢,二进制里也没有指 skill / hook 目录的环境变量(全量扫过
   * `AGY_*`/`ANTIGRAVITY_*`/`GEMINI_*`,只有 `GEMINI_HOME` 挪的是这一整根)。
   * ⇒ 咕咕要往这家的 skill / hook 里放任何东西,唯一的门就是它读的那一整根。
   */
  injectionMode: 'managed-config-root',
  // owner 2026-09-24:只能走订阅 —— 咕咕没有 Gemini 原生上游,格式转换又被禁止(见上面 platformModelUnnameable)。
  platform: { kind: 'unsupported', reason: '只能走用户自己的订阅:咕咕没有 Gemini 原生上游' },
  // 品牌数据根,与 `KIMI_CODE_HOME` 同类:咕咕托管配置根的那把钥匙(`configRoot.envVar`),也是用户自己挪过家时唯一的告知方式 ——
  // 不透传,咕咕算出的托管路径就递不到子进程,登录写一处、会话读另一处(#6335)。
  shellEnv: { passThrough: ['GEMINI_HOME'] },
  configRoot: {
    envVar: 'GEMINI_HOME',
    userPath: '.gemini',
    evidence:
      'agy_acp_server 1.2.1 stderr「Gemini home resolved to <dir> (from $GEMINI_HOME)」,缺省 ~/.gemini'
      + '(2026-09-23/24 MBP 隔离 $GEMINI_HOME 实测:auth 读 <root>/antigravity-acp/settings.json,skill 读 '
      + '<root>/config/skills 与 <root>/antigravity-cli/skills,hook 读 <root>/config/hooks.json,MCP 读 '
      + '<root>/config/mcp_config.json,会话落 <root>/antigravity-acp/{brain,conversations});'
      + '官方 Zed 接入页 https://antigravity.google/docs/ide/extensions/zed 只写了 settings.json 的 auth/gcp',
    // ⚠️ `.gemini` 是几个产品共用的根(2.0 桌面 `antigravity/`、CLI `antigravity-cli/`、IDE
    //    `antigravity-ide/`、ACP `antigravity-acp/`、共享的 `config/`)。照托管规矩**默认全带**
    //    (owner 2026-09-03「托管但不复制 = 合成目录」),这里只减去各家引擎自己会重新放的东西。
    //    布局实测:owner MBP 2026-09-24,`~/.gemini` 67 MB,解引用软链后 212 MB(config/skills 165 条里
    //    157 条是软链,复制时按 copyTree 纪律解引用成实体)。
    carryExclusions: [
      ...(['antigravity', 'antigravity-cli', 'antigravity-ide'] as const).map((product) => ({
        path: `${product}/bin`,
        evidence:
          `MBP 2026-09-24 实测 ${product}/bin 里只有 webm_encoder(12 MB 可执行文件);是程序不是配置 ——`
          + 'ACP 服务运行时自己往 <root>/antigravity/bin/webm_encoder 放(2026-09-23 隔离 $GEMINI_HOME 探针亲见),'
          + '带过来还可能带错架构。',
      })),
      {
        path: 'antigravity-cli/log',
        evidence: 'MBP 2026-09-24 实测为 cli-<时间戳>.log 运行日志,只描述用户那份 CLI 的历史,对咕咕这份没有读者。',
      },
      {
        path: 'antigravity-cli/updater',
        evidence: 'MBP 2026-09-24 实测只有 update.lock 与 update_status.json —— CLI 自更新的锁与记账,指向用户那份安装。',
      },
      ...(['antigravity', 'antigravity-cli', 'antigravity-ide'] as const).map((product) => ({
        path: `${product}/crashes`,
        evidence: `MBP 2026-09-24 实测 ${product}/crashes 为崩溃转储目录;引擎自己会重建,内容只描述用户那份的历史。`,
      })),
    ],
    /**
     * 终端腿的工作区信任 —— `agy` 首次进一个没信任过的目录会先问「trust this folder?」,挡在输入框前。
     * 落点是它自己那份 `antigravity-cli/settings.json` 的 `trustedWorkspaces` 数组(实测,见 evidence)。
     * 宿主按 `trust.channel = 'first-run-state'` 在起终端会话前调(`workspace-trust.ts`),受「自动信任
     * 工作区」设置约束,与 kimi 同一条路;数组按**并集**合并(`applyAgentFirstRunState`),别的工作区一个不丢
     * —— 这份文件 `agy` 自己也会改写(首启把预置的 `colorScheme` 删了),所以只能 key 级合并。
     *
     * ⚠️ 两种写法**都写**:按启动 cwd 原样写的那条才认(只写 realpath `/private/tmp/…` 时它照样问,
     *    写 `/tmp/…` 才不问);realpath 那条留给从真实路径进来的同一个目录。
     * ⚠️ 只管终端腿:聊天面板腿的信任名单是另一份(`antigravity-acp/trusted_workspaces.json`,见 ./stop-hooks.ts)。
     */
    firstRunState: [
      {
        relPath: ANTIGRAVITY_CLI_SETTINGS_REL,
        format: 'json',
        entries: ({ cwd }: { cwd: string }) => ({ trustedWorkspaces: trustedWorkspacePaths(cwd) }),
        evidence:
          `agy ${ANTIGRAVITY_CLI_VERSION} MBP 2026-09-24 影子 HOME 实测:<HOME>/.gemini/antigravity-cli/settings.json `
          + '写 `trustedWorkspaces:["/tmp/…/ws"]` 后 TUI 直接进输入框、不再弹信任询问;只写 realpath '
          + '"/private/tmp/…/ws" 时仍弹。agy 首启会改写这份文件(预置的 colorScheme 被删)⇒ 只做 key 级合并。',
      },
    ],
  },
  /**
   * 关自更新(#6186)—— 终端腿的 `agy` 会自己检查并装新版(官方 docs/cli/troubleshooting.md
   * 「Opt-out/Disable auto-updates: Set the `AGY_CLI_DISABLE_AUTO_UPDATE` environment variable to `true`」)。
   * 走 env:两条腿都拿得到(`selfUpdateEnv` 进同一份 run context),`agy_acp_server` 不认它、多带无害。
   * 不关的话它会把托管装好的那份换掉,「面板显示哪一份就启动哪一份」随之不成立。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    evidence:
      'https://antigravity.google/docs/cli/troubleshooting「Set the `AGY_CLI_DISABLE_AUTO_UPDATE` environment '
      + 'variable to `true`」;取证 2026-09-24',
  },
  surfaces: ANTIGRAVITY_SESSION_TUI_ENABLED ? ['acp', 'tui'] : ['acp'],
  sessionpage: {
    /**
     * 与 gemini 的 `acp` 同声明:身份走通用 provisioning(咕咕的 MCP 经 acp-session 到得了),
     * 普通消息经 router 化成 `route=chat` 信封进 `session/prompt`(#4612,对 provider 通用)。
     *
     * `injection: next-tool-call` 不靠它自己的 steering(1.2.1 `initialize` 不报,忙时并发第二条
     * `session/prompt` 整条连接当场断,「Concurrent receive_steps()」),而靠咕咕的
     * `acp.midTurnSteer: 'interrupt-at-tool-boundary'`:当前工具跑完就 `session/cancel` 这一轮,
     * 插话随即作为下一轮发出。`session/cancel` 保留全部历史(SDK 文档见 evidence;2026-09-24 本地
     * 假端点实测:打断后下一轮的请求里原任务、执行中的工具调用与结果、插话四样都在)。
     */
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence:
          'https://github.com/google-antigravity/antigravity-sdk-python/blob/main/skills/google-antigravity-sdk/examples/getting_started/cancellation.md'
          + ' (cancel aborts inference "while preserving the conversation session and history");'
          + ' https://agentclientprotocol.com/protocol/prompt-turn#cancellation',
        deviations:
          '由咕咕打断再续而非引擎原生 steering:模型正在进行的那一步推理作废重来;在跑的工具不被打断,'
          + '插话在它结束后送达。',
      },
    },
    /**
     * 终端腿 —— 与 qwen / kimi 的终端腿同形:身份走通用 provisioning(咕咕 MCP 经托管 `mcp_config.json`
     * 到得了,见 `units.mcp`),消息经本机会话直投(`local-session`),普通消息按 `prompt.kind: 'argv'`
     * 的约定整段写进 pty 再回车。
     * 入站没写 = deliverable(与其余 local-session 终端腿同形)。
     */
    ...(ANTIGRAVITY_SESSION_TUI_ENABLED
      ? { 'tui': { identity: 'addressable', messageTransport: 'local-session' } as const }
      : {}),
  },
  units: {
    /**
     * MCP —— **两条腿载体不同**,所以按腿声明:
     *  · 聊天面板腿:`session/new` 的 mcpServers(读数见本 descriptor 抬头)。
     *  · 终端腿:咕咕托管那份 `.gemini/config/mcp_config.json` 的 `mcpServers.<名字>`(key 级合并,
     *    用户从自己那份带过来的条目一个不动)。条目是**与会话无关**的 stdio 中继,地址与令牌只在 spawn 环境里,
     *    见 `tuiMcpDelivery`。实测(agy 1.2.9,影子 HOME):中继被拉起、假 MCP 收到 initialize / tools/list;
     *    模型请求的系统提示里出现 `# gugu\nLazy:\n<tool>`、工具表多出通用的 `call_mcp_tool`
     *    (工具名形态见 index.ts 的 `mcp.toolNames`)。
     *    ⚠️ 已知欠账:以 `-i` 起的**第一回合**看不到咕咕的工具 —— agy 在任何 stdio server 应答之前就拼好了那一轮的
     *    `mcp_servers` 提示段(日志「skipping component… empty component: prompt section mcp_servers」);
     *    第二回合起都在。http 条目实测第一回合就在,但 http 条目只能把令牌写进共用文件,那条路 owner 已否。
     *    ⚠️ PTY 那条路只取 argsAppend / env / 落盘项,`acp` 载荷整个被忽略 —— 声明成扁平 native 会让
     *    终端腿恒报 `mcp: loaded` 而一台都没送到(kimi 2026-08-28 实测过的那个形状)。
     */
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        // 共用的 mcp_config.json 里写不了每条会话的 env ⇒ 只收 http(资源库里勾的 stdio 那几台由宿主留在外面)。
        'tui': { kind: 'native', channel: 'config-file', transports: ['http'] },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    /**
     * 两条腿同一个答案:咕咕的平台模型点不了名。终端腿的 `--model` 同样只收它自己目录里的 id
     * (`agy models` 在 API key 模式下列出 `gemini-3.8-flash-high` … `gemini-3.1-pro-low` 共 11 条,
     * 与聊天面板腿 `session/new` 自报的目录同形),用户**自己**的模型经 `--model` 送(index.ts 的
     * `buildCommand`),那不占这一格。
     */
    model: { kind: 'none', degraded: platformModelUnnameable },
    autonomy: { kind: 'none', degraded: autonomyViaAcpModes },
    /**
     * 会话级背景:
     *  · 聊天面板腿:session-context(读数见抬头)。
     *  · 终端腿:`hook-ephemeral` —— PreInvocation 钩子每次调模型前回 `injectSteps:[{ephemeralMessage}]`,
     *    正文来自这次 spawn 的 run-scoped 文件(`tuiInvocationContext`)。实测(2026-09-24,agy 1.2.9 +
     *    本地假端点):第一轮与第二轮的模型请求各带**一份**(不累积,内容是最后一条 user 角色消息),
     *    TUI 屏幕上 0 处;`-i` 起的会话同样带上。
     *    否掉的路(同日实测/文档):`agy --help` 无系统提示旗标;`-i` 的正文铺在用户眼前;
     *    MCP initialize 的 `instructions` **不进**系统提示,只被写成共用根里的
     *    `antigravity-cli/mcp/<server>/instructions.md`(按 server 名一份,并发会话互相覆盖);
     *    自定义 agent(`config/agents/<名>/agent.md`)的正文**替换**默认系统提示、`tools` 缺省为空表
     *    (https://antigravity.google/docs/subagents),等于把 agy 换成另一个 agent。
     */
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        'tui': { kind: 'native', channel: 'hook-ephemeral' },
      },
    },
  },
  /**
   * 终端腿的中断键 —— **单按 Esc**。官方 https://antigravity.google/docs/cli/reference「Global controls」
   * 表原文:「`Esc` | `cli.escape` | Closes active panels, halts active streams, or clears empty prompts.」
   * ⚠️ ❌ 不写 Ctrl-C:同一页「`Ctrl+C` | `cli.exit` | Terminates the CLI session」——那是退出,不是中断。
   * 旧终端腿(merge-base a79ef6b048 的 index.ts)取证同一结论:docs/cli/prompting.md「Pressing `Esc`
   * instantly cancels any active agent turn」,CHANGELOG.md:473 修过「Esc 中断后紧接着输入被吞」。
   * ⚠️ 这里**不动** `coexistence.pause`:双腿的家 pause 记聊天面板腿更强的 `protocol-cancel`,
   *    中断键只由本字段记录(照 kimi)。
   */
  ...(ANTIGRAVITY_SESSION_TUI_ENABLED
    ? {
        sessionTuiInterrupt: {
          sequence: '\u001b',
          evidence:
            'https://antigravity.google/docs/cli/reference「`Esc` | `cli.escape` | … halts active streams」;'
            + 'https://antigravity.google/docs/cli/prompting.md「Pressing `Esc` instantly cancels any active agent turn」;'
            + '取证 2026-08-24 / 2026-09-24',
        },
      }
    : {}),
  extension: { kind: 'none', degraded: noExtension },
  coexistence: {
    /** `session/cancel` 在一条命令跑到一半时发出 → 约 0.7s 后 prompt 以 `stopReason:"cancelled"` 收尾。 */
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /** `session/update` 流实测在跑(tool_call / tool_call_update / agent_message_chunk 全见过)。 */
    observability: { kind: 'native', channel: 'acp-update' },
    /**
     * `default` 档下 `run_command` 触发 `session/request_permission`(kind execute);
     * allow_once → 命令真跑了(文件出现),reject_once → 没跑(stderr「Denied by user」)。
     */
    askUser: { kind: 'native', channel: 'permission-ask' },
    /**
     * 用户自己的 MCP 配置 —— 它起会话时读的正是 `antigravityMcpAdapter()` 扫的那一份:stderr 原文
     * 「Attempting to load global MCP configs from <GEMINI_HOME>/config/mcp_config.json」,
     * 默认 `GEMINI_HOME` 就是 `~/.gemini` ⇒ `~/.gemini/config/mcp_config.json`(与 agy CLI 共用,见 ./mcp.ts)。
     */
    introspection: { kind: 'native', channel: 'config-scan' },
    /*
     * ❌ 没有 `memory`:读数说它**不**把记忆文件递给模型。一次性 git 仓里放 `GEMINI.md`(PROJ-GEMINI-7002)、
     * `AGENTS.md`(PROJ-AGENTS-7003),`$GEMINI_HOME/GEMINI.md`(GLOBAL-MEM-7001),首轮模型请求体里
     * 三个 marker **全部 0 命中**;`.agents/rules/r.md` 无 frontmatter 时它的 harness 报
     * `Invalid rule trigger: CORTEX_MEMORY_TRIGGER_UNSPECIFIED`。agy CLI 文档说它读这几份
     * (gcli-migration.md / rules-workflows.md),但那是 CLI 的行为,不是这个 ACP 服务的。
     */
  },
} satisfies SessionBundleDescriptor;

/** 信任名单里要写的两种写法:启动 cwd 原样 + 它的 realpath(去重)。理由见 `configRoot.firstRunState`。 */
export function trustedWorkspacePaths(cwd: string): string[] {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // 目录还不存在(或读不到)时只写原样那条 —— 它才是 agy 判信任时比对的那一个。
  }
  return real === cwd ? [cwd] : [cwd, real];
}

/**
 * 咕咕托管那份 `.gemini` 下的一个文件。布局只此一处解析(`agentHomeSegments`)——
 * ❌ 别手写 `agent-homes/antigravity/...`,两处各写一遍就是「会话读 A、咕咕写 B」而两边都不报错。
 * 拿不到 `GUGU_HOME` 就抛:那意味着调用方没给数据根,写到别处 = 在用户机器上留残留。
 */
function managedRootPath(bundle: SessionCapabilityBundle, ...segments: readonly string[]): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Antigravity session adapter requires bundle.env.GUGU_HOME');
  return join(
    guguHome,
    ...agentHomeSegments('antigravity', antigravitySessionBundleDescriptor.configRoot.userPath),
    ...segments
  );
}

/** 影子 home(= 托管 `.gemini` 的父目录)下的一个文件 —— 给 shell 还原 HOME 的那两份用。 */
function shadowHomePath(bundle: SessionCapabilityBundle, basename: string): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Antigravity session adapter requires bundle.env.GUGU_HOME');
  // 与 `resolveAgentHome` 同一个切法:布局里除掉 userPath 那几段就是影子 home。
  const segments = agentHomeSegments('antigravity', antigravitySessionBundleDescriptor.configRoot.userPath);
  return join(guguHome, ...segments.slice(0, 2), basename);
}

/**
 * 咕咕 MCP 的 stdio ⇄ HTTP 中继(`apps/desktop/electron/runtime/gugu-mcp-stdio-relay.mjs`)的入口 ——
 * 宿主在起终端腿之前登记成进程环境事实(`registerGuguMcpStdioRelayEntry`,与 codex 桥的
 * `GUGU_CODEX_APP_SERVER_ACP_ENTRY` 同一个做法)。
 */
export const GUGU_MCP_STDIO_RELAY_ENTRY_ENV = 'GUGU_MCP_STDIO_RELAY_ENTRY';

/** 与 codex 那条腿、capability-bundle 的环境变量后缀同一个归一(非 `[A-Za-z0-9_]` → `_`、转大写)。 */
function sessionMcpEnvSuffix(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}

export function sessionMcpUrlEnv(name: string): string {
  return `GUGU_SESSION_MCP_URL_${sessionMcpEnvSuffix(name)}`;
}

export function sessionMcpBearerEnv(name: string): string {
  return `GUGU_SESSION_MCP_BEARER_${sessionMcpEnvSuffix(name)}`;
}

type TuiMcpDelivery = { overlay: JsonOverlay; env: Record<string, string> };

/**
 * 终端腿的 MCP —— 托管 `config/mcp_config.json` 里只写**与会话无关**的条目,会话的地址与令牌只进 spawn 环境。
 *
 * ## 为什么不把地址与令牌写进那份文件
 *
 * owner 原则:一个 harness 一个配置根,❌ 每会话一份。那份文件于是被**所有**终端会话与聊天面板腿共用:
 *  · 两条终端会话并发时,后起的一条把自己的令牌写进去,先起的那条之后若重连,拿的就是别人的身份;
 *  · 聊天面板腿的 `agy_acp_server` 起会话时也加载这份全局文件(stderr「Attempting to load global MCP
 *    configs from <GEMINI_HOME>/config/mcp_config.json」),会拿终端会话的令牌连上咕咕。
 * ⇒ 文件里每台咕咕 server 是一条 stdio 条目,`command` = 随咕咕发的中继(应用级事实,与会话无关);
 *   `GUGU_SESSION_MCP_URL_<后缀>` / `GUGU_SESSION_MCP_BEARER_<后缀>`(codex 那条腿同一套命名)只在这次
 *   spawn 的环境里,`agy` 起 stdio server 时子进程继承它的环境,中继从那里读。
 *   聊天面板腿起同一条中继时环境里没有这两个变量 ⇒ 中继静默退化成一台没有工具的 server(见中继抬头)。
 *
 * ⚠️ 中继用宿主自己那份 node(Electron 配 `ELECTRON_RUN_AS_NODE=1`,与 codex / claude 适配器同一个起法),
 *    用户机器上不要求装 node。
 * ⚠️ **key 级合并**(`conflict: 'gugu-owns'`):文件首次是从用户 `~/.gemini` 整份带过来的,只改咕咕那几个名字。
 * ⚠️ stdio server 不接(descriptor 的 `transports: ['http']`;资源库里勾的 stdio 那几台由宿主按它留在外面):会话级 stdio server 只来自「复述用户自己的 server」,而这一家 `sessionUserServers:
 *    'inherit'`(两个程序都自己读这份文件)⇒ 正常路径上一台都不会有;真出现了就是声明漂了,响亮失败,
 *    ❌ 把它的环境值写进共用文件。
 */
function tuiMcpDelivery(bundle: SessionCapabilityBundle): TuiMcpDelivery | null {
  if (bundle.mcpServers.length === 0) return null;
  const relay = process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV]?.trim();
  if (!relay) {
    throw new Error(
      `Antigravity terminal MCP needs the Gugu MCP stdio relay; ${GUGU_MCP_STDIO_RELAY_ENTRY_ENV} is not registered`
    );
  }
  const servers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  for (const server of bundle.mcpServers) {
    if (server.transport === 'stdio') {
      throw new Error(
        `Antigravity terminal MCP '${server.name}' is stdio: session stdio servers would need per-session env in the `
        + 'shared mcp_config.json (agy reads the user servers there itself)'
      );
    }
    const credential = sessionMcpAuthorization(server, bundle.env, 'Antigravity');
    servers[server.name] = {
      command: process.execPath,
      args: [relay, server.name],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      disabled: false,
    };
    env[sessionMcpUrlEnv(server.name)] = server.url;
    if (credential) env[sessionMcpBearerEnv(server.name)] = credential.replace(/^Bearer\s+/i, '');
  }
  const path = managedRootPath(bundle, ...ANTIGRAVITY_MCP_CONFIG_REL);
  return {
    overlay: { sourcePath: path, path, patch: { mcpServers: servers }, conflict: 'gugu-owns', mode: 0o600 },
    env,
  };
}

/**
 * 跳过首启向导(配色选择)—— 否则终端会话起来停在向导上,首句 `-i` 进不去。
 *
 * 实测(agy 1.2.9,影子 HOME):`antigravity-cli/cache/onboarding.json` 写
 * `{"consumerOnboardingComplete":true,…,"onboardingComplete":true}` 后直接进输入框;在 `settings.json`
 * 预置 `colorScheme` **无效**(首启被 agy 改写掉)。用户自己用过 agy 时带过来的那份本来就是 true。
 * ⚠️ 每次终端会话都合并一遍、只写这两个键(`enterpriseOnboardingComplete` 不碰):用户没装过 agy 时
 *    托管根是空的(`ensureAgentHome` 走 source-absent,种子文件那条路到不了),只能在这里补。
 */
function tuiOnboardingOverlay(bundle: SessionCapabilityBundle): JsonOverlay {
  const path = managedRootPath(bundle, ...ANTIGRAVITY_ONBOARDING_REL);
  return {
    sourcePath: path,
    path,
    patch: { consumerOnboardingComplete: true, onboardingComplete: true },
    conflict: 'gugu-owns',
    mode: 0o600,
  };
}

/**
 * 终端腿的会话提示块:一份 run-scoped 的钩子输出档 + 指过去的 env(通道 `hook-ephemeral`)。
 *
 * ⚠️ 每次 spawn 都写一份新的(路径里是现生成的 uuid):身份块只活在这次进程的环境里,两条并发会话、
 *    同一条会话的前后两代进程都拿不到彼此的。续跑也照写 —— ephemeral 消息不进历史,不写身份就没了。
 * ⚠️ 落在 `GUGU_HOME/runtime-sessions/` 下(与 kimi 的 agent 档同一个根),❌ 不写进共用的托管配置根。
 * ⚠️ 0600:正文里有这个 agent 的咕咕身份。
 */
function tuiInvocationContext(
  bundle: SessionCapabilityBundle
): { artifact: GeneratedArtifact; env: Record<string, string>; delivered: (keyof SessionPromptBlocks)[] } | null {
  const rendered = sessionContextPrompt(bundle.promptBlocks);
  if (!rendered) return null;
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Antigravity session adapter requires bundle.env.GUGU_HOME');
  const path = join(guguHome, 'runtime-sessions', 'antigravity-invocation-context', randomUUID(), 'pre-invocation.json');
  return {
    artifact: {
      path,
      content: JSON.stringify({ injectSteps: [{ ephemeralMessage: rendered.value }] }),
      mode: 0o600,
    },
    env: { [ANTIGRAVITY_INVOCATION_CONTEXT_ENV]: path },
    delivered: [...rendered.delivered],
  };
}

/** 影子 home 里给 agent 的 shell 还原真 HOME 的两份文件(理由见 `ANTIGRAVITY_HOME_RESTORE_*`)。 */
function homeRestoreArtifacts(bundle: SessionCapabilityBundle): GeneratedArtifact[] {
  return [
    { path: shadowHomePath(bundle, ANTIGRAVITY_HOME_RESTORE_ZSHENV), content: ZSHENV_CONTENT, mode: 0o644 },
    { path: shadowHomePath(bundle, ANTIGRAVITY_HOME_RESTORE_BASH_ENV), content: BASH_ENV_CONTENT, mode: 0o644 },
  ];
}

export function materializeAntigravitySessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!antigravitySessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Antigravity session adapter does not support surface '${ctx.surface}'`);
  }
  // 平台模型点不了名(见 `platformModelUnnameable`)—— 响亮拒绝,❌ 不静默把平台额度会话开在
  // 它自己的默认模型、用户自己的账号上(那是「界面写 A、实际跑 B」,且计费打错人)。两条腿同一个答案。
  if (bundle.model?.platformProvider) {
    throw new Error(`Antigravity session adapter cannot deliver a Gugu platform model: ${platformModelUnnameable.reason}`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // http 的凭据已经进了 Authorization(协议腿的头 / 终端腿的配置文件),❌ 不再留在子进程环境里。
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }
  const loaded = { status: 'loaded' as const };
  if (ctx.surface === 'tui') return materializeSessionTui(ctx, bundle, env);

  const mcpServers = sessionMcpProtocolServers(bundle, 'Antigravity');
  const prompt = sessionContextPrompt(bundle.promptBlocks);
  return {
    argsAppend: [],
    env,
    acp: { mcpServers },
    ...(prompt ? { prompt } : {}),
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'antigravity',
      surface: ctx.surface,
      units: {
        mcp: loaded,
        env: loaded,
        model: { status: 'degraded', reason: platformModelUnnameable },
        autonomy: { status: 'degraded', reason: autonomyViaAcpModes },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were declared.' } },
        packages: { status: 'degraded', reason: noExtension },
      },
      discoveredCommands: [],
    },
  };
}

/**
 * 终端腿的物化 —— 只落盘,不动 argv:
 *  · 咕咕 MCP 以与会话无关的中继条目合并进托管 `mcp_config.json`,会话地址与令牌进 `env`(`tuiMcpDelivery`);
 *  · 首启向导标成已完成(`tuiOnboardingOverlay`);
 *  · 影子 home 里写好给 agent shell 还原真 HOME 的两份文件(`homeRestoreArtifacts`);
 *  · 会话提示块写成 PreInvocation 钩子的输出档,env 指过去(`tuiInvocationContext`)。
 * 换 HOME 本身在 `buildCommand` 的启动器里(理由见 `ANTIGRAVITY_LAUNCH_SCRIPT`);回合边界钩子由
 * hooks 写入器(`./hooks.ts`,`scope: 'agent-home'`)在起会话前写进同一份托管根。
 * 会话身份走进程环境(`env`,宿主注入的 `GUGU_*`),❌ 不写进任何配置文件。
 */
function materializeSessionTui(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
  env: Record<string, string>
): SessionMaterialization {
  const mcp = tuiMcpDelivery(bundle);
  const context = tuiInvocationContext(bundle);
  return {
    argsAppend: [],
    env: { ...env, ...(mcp?.env ?? {}), ...(context?.env ?? {}) },
    configMerges: [],
    artifacts: [...homeRestoreArtifacts(bundle), ...(context ? [context.artifact] : [])],
    jsonOverlays: [...(mcp ? [mcp.overlay] : []), tuiOnboardingOverlay(bundle)],
    report: {
      adapterId: 'antigravity',
      surface: ctx.surface,
      units: {
        mcp: mcp
          ? { status: 'loaded' }
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No MCP server was declared.' } },
        env: { status: 'loaded' },
        model: { status: 'degraded', reason: platformModelUnnameable },
        autonomy: { status: 'degraded', reason: autonomyViaAcpModes },
        promptBlocks: context
          ? { status: 'loaded' }
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were declared.' } },
        packages: { status: 'degraded', reason: noExtension },
      },
      discoveredCommands: [],
    },
  };
}
