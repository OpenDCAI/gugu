import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins';
import {
  integrationPluginRegistry,
  type IntegrationCliMethod,
} from '@gugu/session-plugins/integrations';
import { readExtensionSkills } from '../../../../../extension-session-mcp';
import { cliLauncherDir } from './cli-paths';
import { installedCliTool, isCliToolInstalled, type InstalledCliTool } from './cli-tool-installer';
import { cliToolRecipe, type CliToolRecipe } from './cli-tools';

/** 这家集成走官方命令行吗;是 → 它的那一条授权方式。 */
export function cliMethodOf(integrationId: string): IntegrationCliMethod | null {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  const method = methods.find((candidate) => candidate.kind === 'cli');
  return method?.kind === 'cli' ? method : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * agent 敲的那个命令:一个小脚本,带上这个工具在咕咕里的登录态目录,再交给装好的程序。
 * 连上才写、断开就删 —— agent 的 PATH 上有它 = 在咕咕里连着。
 */
export function cliLauncherScript(recipe: CliToolRecipe, installed: InstalledCliTool): string {
  const env = Object.entries(recipe.env(installed.homeDir))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  return `#!/bin/sh\n# 咕咕资源库里连上的 ${recipe.bin} ${installed.version}\n${env}\nexec ${shellQuote(installed.binPath)} "$@"\n`;
}

export async function publishCliLauncher(recipe: CliToolRecipe, installed: InstalledCliTool, guguHome?: string): Promise<void> {
  const dir = cliLauncherDir(guguHome);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, recipe.bin);
  const script = cliLauncherScript(recipe, installed);
  const previous = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous === script) {
    if (!((await fs.stat(file)).mode & 0o111)) await fs.chmod(file, 0o755);
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, script, { mode: 0o755 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function removeCliLauncher(recipe: CliToolRecipe, guguHome?: string): Promise<void> {
  await fs.rm(path.join(cliLauncherDir(guguHome), recipe.bin), { force: true });
}

/**
 * 已连接的官方命令行带给会话的 skills(钉钉的 `dws`、企业微信的 `wecomcli-*`)。和 App 的 skills 走同一条路
 * (#6387:能原生挂载的 harness 挂成自己的 skill,别的在开场列出 SKILL.md 的位置)。
 * 读不了的那一份由 `readExtensionSkills` 说出来、❌ 抛 —— 会话永远要能开。
 */
export async function connectedCliSkills(
  isConfigured: (integrationId: string) => Promise<boolean>,
  onProblem: (message: string) => void
): Promise<ExtensionSkill[]> {
  const skills: ExtensionSkill[] = [];
  for (const plugin of integrationPluginRegistry.getAll()) {
    const integrationId = plugin.metadata.id;
    const method = cliMethodOf(integrationId);
    if (!method || !(await isConfigured(integrationId))) continue;
    if (!isCliToolInstalled(method.tool)) {
      onProblem(`integration ${integrationId}: ${method.tool} is connected but not installed; its skills are left out.`);
      continue;
    }
    const installed = installedCliTool(method.tool);
    try {
      // The selected binary can change after restore or adopting a verified preinstall.
      // Refresh only connected entries; account credentials stay in the same HOME.
      await publishCliLauncher(cliToolRecipe(method.tool), installed);
    } catch (error) {
      onProblem(`integration ${integrationId}: command launcher is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    skills.push(...readExtensionSkills(integrationId, installed.skillsDir, onProblem));
  }
  return skills;
}
