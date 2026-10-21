export interface SessionEnvContext {
  /** 变量名还叫 TASK_*:那是用户脚本里写着的名字(`.gugu.json`),值是这条会话的。 */
  session: { id: string; title: string };
  sessionPath: string;
  projectPath: string;
  defaultBranch?: string;
  portSeed?: string;
}

export function getSessionEnvVars(ctx: SessionEnvContext): Record<string, string> {
  const sessionName = slugify(ctx.session.title) || 'task';
  const portSeed = ctx.portSeed || ctx.sessionPath || ctx.session.id;
  const vars = {
    TASK_ID: ctx.session.id,
    TASK_NAME: sessionName,
    TASK_PATH: ctx.sessionPath,
    ROOT_PATH: ctx.projectPath,
    DEFAULT_BRANCH: ctx.defaultBranch || 'main',
    PORT: String(getBasePort(portSeed)),
  };
  // 新名字是 GUGU_*。改名前的 EMDASH_* 照样给一份:这些变量是给用户自己写的 setup / run 脚本用的,
  // 已经写进 `.gugu.json`(或旧的 `.emdash.json`)里的 `$EMDASH_TASK_PATH` 不能因为改名就静默变成空串。
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    env[`GUGU_${name}`] = value;
    env[`EMDASH_${name}`] = value;
  }
  return env;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getBasePort(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return 50000 + (Math.abs(hash) % 1000) * 10;
}
