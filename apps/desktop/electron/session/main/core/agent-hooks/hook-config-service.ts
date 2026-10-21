import { homedir } from 'node:os';
import { HarnessStartupError, type PluginFs } from '@gugu/session-core/agents/plugins';
import { resolveAgentHomeRoot } from '@main/core/agents/agent-home';
import { createPluginFs } from '@main/core/agents/plugin-fs';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { appSettingsService } from '@main/core/settings/settings-service';

const GITIGNORE_PATH = '.gitignore';

/**
 * 用户工作区(项目目录)的文件读写。读写失败(只读、没权限、磁盘满)是用户环境那一侧的原因,与配置语法错同一类:
 * 包成 `HarnessStartupError`,起任务失败时照原话上屏,带上项目里的相对路径(#7103 谁拒绝谁说话)。
 * 咕咕托管的 agent-home 根不走这里:那是咕咕自己的目录,写不进去算咕咕这一侧。
 */
export function userWorkspaceFs(sessionPath: string): PluginFs {
  const fs = createPluginFs(sessionPath);
  const said = (verb: string, path: string) => (error: unknown): never => {
    if (error instanceof HarnessStartupError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new HarnessStartupError(`Could not ${verb} ${path} in this project: ${detail}`, { cause: error });
  };
  return {
    ...fs,
    read: (path) => fs.read(path).catch(said('read', path)),
    write: (path, content) => fs.write(path, content).catch(said('write', path)),
  };
}

async function ensureGitIgnoreEntries(sessionPath: string, entries: string[]): Promise<void> {
  const wsFs = userWorkspaceFs(sessionPath);
  const existing = (await wsFs.read(GITIGNORE_PATH)) ?? '';
  const existingLines = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  const isIgnored = (entry: string) => {
    const norm = entry.replace(/^\/+/, '');
    return existingLines.some((raw) => {
      const p = raw.replace(/^\/+/, '');
      if (p === norm) return true;
      if (p.endsWith('/')) return norm.startsWith(p);
      if (p.endsWith('/**')) return norm.startsWith(p.slice(0, -2));
      return false;
    });
  };

  const missing = entries.filter((e) => !isIgnored(e));
  if (missing.length === 0) return;

  const content = existing.replace(/\s*$/, '');
  const next =
    content.length > 0 ? `${content}\n${missing.join('\n')}\n` : `${missing.join('\n')}\n`;
  await wsFs.write(GITIGNORE_PATH, next);
}

/**
 * `agent-home` 的根必须是咕咕托管的独立配置根。解析回用户真 HOME(没声明 `configRoot`、或托管根
 * 没解析出来)= descriptor 与实现不一致 ⇒ 抛,❌ 不退回去写用户的文件。
 */
async function managedAgentHomeRoot(providerId: string): Promise<string> {
  const root = await resolveAgentHomeRoot(providerId);
  if (root === homedir()) {
    throw new Error(
      `hooks scope 'agent-home' for '${providerId}' resolved to the user's real HOME; `
      + 'declare a managed configRoot or a session hooks channel instead of writing user config'
    );
  }
  return root;
}

/**
 * Ensures hooks and plugins are installed for the given provider on every
 * conversation spawn. Writes are idempotent (small-file merges), so re-writing
 * before every spawn removes the "config got cleaned mid-task" failure mode.
 *
 * 装不上(配置语法错、写盘失败、版本门缺版本)就抛:会话起不来并说出原因,❌ 不静默照常起 ——
 * 那会让状态读数永远停在出生态,看上去一切正常。
 */
export async function ensureHooksInstalled({
  providerId,
  sessionPath,
  harnessVersion,
}: {
  providerId: string;
  sessionPath: string;
  /** 这一次将要 spawn 的那个可执行文件的版本(runtime-compatible 探针的读数);不探版本的家为 null。 */
  harnessVersion: string | null;
}): Promise<void> {
  const localProjectSettings = await appSettingsService.get('localProject');
  const writeGitIgnoreEntries = localProjectSettings.writeAgentConfigToGitIgnore ?? true;

  const plugin = getPlugin(providerId);
  const hooksDescriptor = plugin.capabilities.hooks;
  const hooksKind = hooksDescriptor.kind;
  let writtenPaths: string[] = [];

  if (hooksKind === 'config' && hooksDescriptor.scope === 'session') {
    // 会话自有:条目由这一家的 tui 物化器写进 run 目录(或由 host adapter 的协议直接回传),
    // 这里一个字节都不写 —— 用户 HOME 下的配置只读(spec capability-bundle)。
  } else if (hooksKind === 'config') {
    const writeHooks = plugin.behavior.hooks?.writeHooks;
    if (!writeHooks) {
      throw new Error(`hooks scope '${hooksDescriptor.scope}' for '${providerId}' declares a file writer but none is registered`);
    }
    const root = hooksDescriptor.scope === 'agent-home'
      ? await managedAgentHomeRoot(providerId)
      : sessionPath;
    const fs = hooksDescriptor.scope === 'agent-home' ? createPluginFs(root) : userWorkspaceFs(root);
    const paths = await writeHooks(fs, [], { harnessVersion });
    // 托管配置根里的路径相对于那个根,不属于工作区 ⇒ 不进工作区 .gitignore。
    writtenPaths = hooksDescriptor.scope === 'workspace' ? paths : [];
  } else if (hooksKind === 'plugin' && plugin.behavior.plugins) {
    const fs = userWorkspaceFs(sessionPath);
    writtenPaths = await plugin.behavior.plugins.installPlugin(fs, {
      kind: 'workspace',
      path: sessionPath,
    });
  }

  if (writeGitIgnoreEntries && writtenPaths.length > 0) {
    await ensureGitIgnoreEntries(sessionPath, writtenPaths);
  }
}
