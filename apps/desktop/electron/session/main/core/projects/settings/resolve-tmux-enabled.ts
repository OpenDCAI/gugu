import { appSettingsService } from '@main/core/settings/settings-service';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import type { ProjectSettingsProvider } from './provider';

/**
 * 这个项目的会话跑不跑在 tmux 里 —— spawn 与退出拆除共用这一个答案。
 *
 * Resolve tmux at spawn time so a changed global default reaches later sessions.
 * The implicit task-home project is created as an implementation detail and its
 * first stored value is only a bootstrap seed; it must follow the global default.
 *
 * @@@4467 退出拆除(detach 还是 terminate)也必须问这里。此前 ProjectProvider.dispose 直接读项目存的那颗种子:
 * 隐式任务工作区在打开 tmux 之前就建好了,种子是 false,而 spawn 按全局默认已经跑进 tmux ⇒ 退出按 terminate
 * 把 tmux 会话连同里面的 harness 一起杀掉,detach 名存实亡(mac1 实读:种子 `"tmux":false`、全局
 * `tmuxByDefault:true`,SIGTERM 后该 profile 的 tmux 会话立刻消失,tmux 服务器仍在)。
 */
export async function resolveTmuxEnabled(
  settings: ProjectSettingsProvider,
  projectId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (serverAlwaysUsesTmux(env)) return true;
  const projectSettings = await settings.get();
  if (projectId && isImplicitSessionHomeProjectId(projectId)) {
    return (await appSettingsService.get('project')).tmuxByDefault;
  }
  if (projectSettings.tmux !== undefined) return projectSettings.tmux;
  return (await appSettingsService.get('project')).tmuxByDefault;
}

/**
 * #6264 咕咕 server 上的会话一律跑在 tmux 里(product spec 第 5 条「切换不影响终端会话」):
 * 升级、重启、崩溃只换掉 server 进程,终端里的程序与回滚历史留在 tmux 服务端,账号进程回来后照名字接回去。
 * 不看项目里存的那颗种子 —— 老项目建的时候出厂值还是 false,server 上没有地方让人改它,它也不该被改。
 * 只在包里真带了 tmux(入口设了 GUGU_TMUX_BIN)时才这么做;开发时手动起的 server 没有它,仍按设置走。
 */
export function serverAlwaysUsesTmux(env: NodeJS.ProcessEnv): boolean {
  return env.GUGU_SERVER_MODE === '1' && Boolean(env.GUGU_TMUX_BIN?.trim());
}
