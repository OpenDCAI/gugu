import type {
  IMcpBehavior,
  McpScopedServers,
  McpServerRegistration,
  PluginFs,
} from '@gugu/session-core/agents/plugins';
import { passthroughMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';

/**
 * Claude 的 MCP 照它**自己**的合并规则读 —— Claude 没有「不连接、结构化」的列法(`claude mcp list` 逐台连接、
 * 只出文本),所以这里是咕咕唯一的一份读法,每一层都写出处。10-17 资源库 MCP 核查之前这里只读了
 * `~/.claude.json` 与 `<目录>/.mcp.json`,漏了插件层与两份关闭 / 批准名单。
 *
 * 文档:https://code.claude.com/docs/en/mcp(Installing MCP servers · scopes、Disable a server without removing it、
 * project-server approvals)、https://code.claude.com/docs/en/settings(Settings precedence)、
 * https://code.claude.com/docs/en/plugins-reference(mcpServers、`${CLAUDE_PLUGIN_ROOT}`)。
 *
 * - 用户级:`~/.claude.json` 顶层 `mcpServers`。
 * - 插件:`~/.claude/settings.json` 的 `enabledPlugins` 里开着的插件,装在 `~/.claude/plugins/installed_plugins.json`
 *   记的 `installPath`;server 来自插件根的 `.mcp.json`,再叠 `plugin.json` 的 `mcpServers`(路径 / 内联表 / 二者的数组,
 *   后声明的同名者胜)。行名是 Claude 自己的 `plugin:<插件>:<server>`(`claude mcp list` 原样这么列)。
 *   `.mcpb` / `.dxt` 包要解开才知道 server 名 —— 不列。
 * - 本地级:`~/.claude.json` 的 `projects[<目录>].mcpServers`(`claude mcp add` 的缺省作用域)。
 *   键是**真实路径**:`/tmp/x` 下起的会话读不到 `projects["/tmp/x"]`(macOS 上它是 `/private/tmp/x`;10-07 实测)。
 * - 本地关闭:`projects[<目录>].disabledMcpServers` —— `/mcp` 里关掉一台写的就是它,覆盖用户级、本地级、插件 server,
 *   **只对这个目录**(docs「Disable a server without removing it」;claude 2.1.293 自带的提示文本同句)。
 * - 项目级:`<目录>/.mcp.json` 的每一台,状态按 settings 的键算(docs 标为 Any file,四份都读:
 *   `~/.claude.json` 的 `projects[<目录>]`、`<目录>/.claude/settings.local.json`、`<目录>/.claude/settings.json`、
 *   `~/.claude/settings.json`):在 `disabledMcpjsonServers` 里 = 停用(`claude mcp list` 连列都不列,
 *   「Rejected」);其余都算进来。批准名单(`enabledMcpjsonServers` / `enableAllProjectMcpServers`)只决定交互会话
 *   (咕咕的终端腿)连不连,非交互(`claude -p`、SDK)照样连(docs 同节;10-07 / 10-17 实测两腿各一次)——
 *   咕咕这一侧不区分(从前只给 10-18 删掉的资源库 MCP 页标「待批准」用)。
 * - 项目里另开 / 另关的插件:`<目录>/.claude/settings.json` 与 `settings.local.json` 的 `enabledPlugins` 按优先级
 *   盖过用户那份(local > project > user,docs「Settings precedence」);与用户级结论不同的插件,它的 server 记在这个目录下。
 */

type Json = Record<string, unknown>;

/** 读一份 JSON 对象;不在、读不懂都是 null —— 那一份里的东西,Claude 自己也一样用不上。 */
async function readJsonObject(fs: PluginFs, path: string): Promise<Json | null> {
  const content = await fs.read(path);
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function registrationsOf(servers: unknown): McpServerRegistration[] {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers as Json)
    .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
    .map(([name, raw]) => ({ ...(raw as Json), name }));
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function enabledPluginsOf(settings: Json | null): Record<string, boolean> {
  const value = settings?.enabledPlugins;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Json).filter(([, on]) => typeof on === 'boolean')) as Record<string, boolean>;
}

/** `installPath` 是绝对路径,而 fs 以用户 home 为根:取 `.claude/plugins/` 起的那一段。 */
function homeRelative(installPath: string): string {
  const normalized = installPath.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/.claude/plugins/');
  if (at < 0) throw new Error(`Claude plugin installPath is outside ~/.claude/plugins: ${installPath}`);
  return normalized.slice(at + 1);
}

function substitutePluginRoot(reg: McpServerRegistration, root: string): McpServerRegistration {
  const sub = (value: string) => value.split('${CLAUDE_PLUGIN_ROOT}').join(root);
  return {
    ...reg,
    ...(typeof reg.command === 'string' ? { command: sub(reg.command) } : {}),
    ...(Array.isArray(reg.args) ? { args: reg.args.map((arg) => (typeof arg === 'string' ? sub(arg) : arg)) } : {}),
  };
}

type InstalledPlugins = Record<string, { scope?: string; installPath?: string; projectPath?: string }[]>;

/** 一个插件带的 server:插件根 `.mcp.json` 先,再 `plugin.json` 的 `mcpServers` 按声明顺序,同名后者胜。 */
async function pluginServers(fs: PluginFs, pluginId: string, installPath: string): Promise<McpServerRegistration[]> {
  const root = homeRelative(installPath);
  const manifest = await readJsonObject(fs, `${root}/.claude-plugin/plugin.json`);
  const pluginName = typeof manifest?.name === 'string' ? manifest.name : pluginId.split('@')[0];
  const byName = new Map<string, McpServerRegistration>();
  const add = (servers: unknown) => {
    for (const reg of registrationsOf(servers)) byName.set(reg.name, reg);
  };
  add((await readJsonObject(fs, `${root}/.mcp.json`))?.mcpServers);
  const declared = manifest?.mcpServers;
  for (const shape of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (typeof shape === 'string') {
      if (/\.(mcpb|dxt)$/i.test(shape) || /^https?:/i.test(shape)) continue;
      const file = await readJsonObject(fs, `${root}/${shape.replace(/^\.\//, '')}`);
      add(file?.mcpServers ?? file);
    } else {
      add(shape);
    }
  }
  return [...byName.values()].map((reg) => ({
    ...substitutePluginRoot(reg, installPath),
    name: `plugin:${pluginName}:${reg.name}`,
  }));
}

/**
 * 开着的那几个插件各带哪几台。某一个插件读不了(`installPath` 不在 `~/.claude/plugins` 下)就跳过它,
 * ❌ 让整家 Claude 都读不出来(复核三代 10-17)。
 */
async function enabledPluginServers(
  fs: PluginFs,
  installed: InstalledPlugins,
  enabled: Record<string, boolean>,
  projectPath?: string
): Promise<Map<string, McpServerRegistration[]>> {
  const byPlugin = new Map<string, McpServerRegistration[]>();
  for (const [pluginId, on] of Object.entries(enabled)) {
    if (!on) continue;
    const entries = installed[pluginId] ?? [];
    const entry = entries.find((candidate) => projectPath && candidate.projectPath === projectPath)
      ?? entries.find((candidate) => candidate.scope === 'user');
    if (!entry?.installPath) continue;
    try {
      byPlugin.set(pluginId, await pluginServers(fs, pluginId, entry.installPath));
    } catch {
      // 跳过这一个插件,见上。
    }
  }
  return byPlugin;
}

async function readInstalledPlugins(fs: PluginFs): Promise<InstalledPlugins> {
  const plugins = (await readJsonObject(fs, '.claude/plugins/installed_plugins.json'))?.plugins;
  return plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? (plugins as InstalledPlugins) : {};
}

export function claudeMcpAdapter(): IMcpBehavior {
  const passthrough = passthroughMcpAdapter('.claude.json');
  const userPluginServers = async (fs: PluginFs) =>
    enabledPluginServers(fs, await readInstalledPlugins(fs), enabledPluginsOf(await readJsonObject(fs, '.claude/settings.json')));
  const readServers = async (fs: PluginFs): Promise<McpServerRegistration[]> => {
    const user = await passthrough.readServers(fs);
    const byPlugin = await userPluginServers(fs);
    return [...user, ...[...byPlugin.values()].flat()];
  };
  return {
    ...passthrough,
    readServers,
    async readScopedServers(fs, dirs) {
      const claudeJson = await readJsonObject(fs, '.claude.json');
      const projects = claudeJson?.projects;
      const byDir = projects && typeof projects === 'object' ? (projects as Record<string, Json>) : {};
      const userSettings = await readJsonObject(fs, '.claude/settings.json');
      const installed = await readInstalledPlugins(fs);
      const userPlugins = enabledPluginsOf(userSettings);
      const global = await readServers(fs);
      const scoped: McpScopedServers[] = [];
      for (const { dir, fs: dirFs } of dirs) {
        const entry = byDir[dir] ?? {};
        const projectSettings = await readJsonObject(dirFs, '.claude/settings.json');
        const localSettings = await readJsonObject(dirFs, '.claude/settings.local.json');
        const off = new Set(stringsOf(entry.disabledMcpServers));

        // 本地级 + 这个目录里关掉的用户级 / 插件 server(同名的本地级盖过用户级,所以只补没被本地级重定义的)。
        const local = registrationsOf(entry.mcpServers).map((reg) => (off.has(reg.name) ? { ...reg, enabled: false } : reg));
        const localNames = new Set(local.map((reg) => reg.name));
        const closedHere = global
          .filter((reg) => off.has(reg.name) && !localNames.has(reg.name))
          .map((reg) => ({ ...reg, enabled: false }));
        if (local.length + closedHere.length > 0) scoped.push({ kind: 'local', dir, servers: [...local, ...closedHere] });

        // 项目级 `.mcp.json`:被拒的停用,其余照样算(批准名单见文件头)。
        const layers = [entry, localSettings, projectSettings, userSettings];
        const rejected = new Set(layers.flatMap((layer) => stringsOf(layer?.disabledMcpjsonServers)));
        const project = registrationsOf((await readJsonObject(dirFs, '.mcp.json'))?.mcpServers).map((reg) =>
          rejected.has(reg.name) ? { ...reg, enabled: false } : reg
        );

        // 这个目录里另开 / 另关的插件。
        const here = { ...userPlugins, ...enabledPluginsOf(projectSettings), ...enabledPluginsOf(localSettings) };
        const changed = Object.keys(here).filter((id) => Boolean(here[id]) !== Boolean(userPlugins[id]));
        const openedHere = await enabledPluginServers(
          fs,
          installed,
          Object.fromEntries(changed.filter((id) => here[id]).map((id) => [id, true])),
          dir
        );
        const closedPlugins = await enabledPluginServers(
          fs,
          installed,
          Object.fromEntries(changed.filter((id) => !here[id]).map((id) => [id, true]))
        );
        const plugins = [
          ...[...openedHere.values()].flat(),
          ...[...closedPlugins.values()].flat().map((reg) => ({ ...reg, enabled: false })),
        ];
        if (project.length + plugins.length > 0) scoped.push({ kind: 'project', dir, servers: [...project, ...plugins] });
      }
      return scoped;
    },
  };
}
