import { homedir } from 'node:os';
import {
  applyAgentFirstRunState,
  createLocalPluginFs,
  ensureAgentHome,
  resolveAgentHome,
} from '@gugu/session-core/agents/plugins/helpers';
import { getPlugin } from '@main/core/agents/plugin-registry';

/**
 * 这一家的**独立 home** 该往子进程里塞什么 env —— electron 主进程这一侧的唯一入口。
 *
 * ## 为什么要有这个文件
 *
 * 咕咕起引擎有**三条**互不相通的路,各自造各自的 env:
 *
 *  · ACP 会话 / 登录 —— `AgentPluginHost` → `spawn-context.ts`(runtime worker 进程里)
 *  · 模型清单探测   —— `resolveLocalAcpSpawnContext`(electron 主进程)
 *  · TUI 腿会话     —— `local-session.ts` 直接 `buildCommand` + `pty-env` 的 `buildAgentEnv`
 *
 * 独立 home 只要漏掉其中**任意一条**,那条路就读**用户那份**配置根,而别的路读咕咕这份 ——
 * 两边都不报错,只是列出的模型不一样、登录态对不上、hook 写的配置会话看不见。
 * ⇒ 后两条(electron 侧)共用这一个函数,第一条在 `plugin-host.ts` 里接同一套解析。
 *
 * ❌ 不硬编码任何一家:只认 descriptor 上的 `configRoot` 声明。没声明的家返回空对象。
 */
const cache = new Map<string, Promise<Resolved>>();

type Resolved = { env: Record<string, string>; root: string };

export async function resolveAgentHomeEnv(providerId: string): Promise<Record<string, string>> {
  return (await resolveOnce(providerId)).env;
}

/**
 * 这一家的**全局配置该锚在哪个目录**。独立 home 的家给影子 home,其余给用户真 OS home。
 *
 * ⚠️ 咕咕写的全局 hook 用的是这个根(`hook-config-service.ts`)。漏掉它 = hook 写进
 *    用户真 home 的 config.toml,而会话读咕咕那份 —— **两边都不报错**,只是 hook 一条都不响。
 */
export async function resolveAgentHomeRoot(providerId: string): Promise<string> {
  return (await resolveOnce(providerId)).root;
}

/** Provision and apply descriptor-declared dynamic first-run state for one workspace. */
export async function prepareAgentFirstRunState(
  providerId: string,
  workspacePath: string
): Promise<string | null | undefined> {
  const bundle = getPlugin(providerId)?.capabilities?.sessionBundle;
  if (!bundle) return undefined;
  if (bundle.injectionMode !== 'managed-config-root') return undefined;
  const spec = bundle.configRoot;
  if (!spec) return undefined;
  const guguHome = process.env.GUGU_HOME ?? '';
  const home = resolveAgentHome({
    providerId,
    injectionMode: bundle.injectionMode,
    configRoot: spec,
    guguHome,
    osHomeDir: homedir(),
    sourceEnv: process.env,
  });
  if (!home) return null;
  await ensureAgentHome(home);
  if (home.firstRunState && home.firstRunState.length > 0) {
    await applyAgentFirstRunState(home, createLocalPluginFs(home.configRoot), workspacePath);
  }
  return home.configRoot;
}

function resolveOnce(providerId: string): Promise<Resolved> {
  const cached = cache.get(providerId);
  if (cached) return cached;
  const task = compute(providerId);
  cache.set(providerId, task);
  return task;
}

async function compute(providerId: string): Promise<Resolved> {
  const osHomeDir = homedir();
  let bundle;
  try {
    bundle = getPlugin(providerId).capabilities.sessionBundle;
  } catch {
    // 认不出的 provider 不是这一层该报的错 —— 调用方自己会在解析 CLI 时响亮地失败。
    return { env: {}, root: osHomeDir };
  }
  if (!bundle) return { env: {}, root: osHomeDir };
  const configRoot = bundle.configRoot;
  const home = resolveAgentHome({
    providerId,
    injectionMode: bundle.injectionMode,
    configRoot,
    guguHome: process.env.GUGU_HOME ?? '',
    osHomeDir,
    sourceEnv: process.env,
  });
  if (!home) return { env: {}, root: osHomeDir };
  // ⚠️ 首次会**整份复制**用户那份过来。时机与幂等见 `helpers/agent-home.ts` 的抬头。
  await ensureAgentHome(home);
  const spec = configRoot;
  return {
    env: spec?.injectEnv === false ? {} : { [home.envVar]: home.configRoot },
    root: home.shadowHome,
  };
}
