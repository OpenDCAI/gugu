import { createHash } from 'node:crypto';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { objectAt, readJsonObject } from '../../helpers/subscription';

/** The Claude Code keychain service is scoped by CLAUDE_CONFIG_DIR, as in cockpit-tools. */
export async function readClaudeAccessToken(ctx: AgentAuthContext): Promise<string | null> {
  if (ctx.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return ctx.env.CLAUDE_CODE_OAUTH_TOKEN.trim();
  const configDir = ctx.env.CLAUDE_CONFIG_DIR?.trim();
  let credentials: Record<string, unknown> | null = null;
  // 钥匙串条目按 CLAUDE_CONFIG_DIR 命名,与手上这把 fs 照不照得到那个目录无关:用户自己导出了它也读得到。
  if (process.platform === 'darwin') {
    const suffix = configDir ? `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}` : '';
    try {
      const { stdout } = await ctx.exec('/usr/bin/security', ['find-generic-password', '-s', `Claude Code-credentials${suffix}`, '-w'], { timeout: 5_000 });
      const parsed: unknown = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) credentials = parsed as Record<string, unknown>;
      else throw new Error('Invalid credentials');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 44) throw new Error('无法读取 Claude Code 的系统钥匙串。');
    }
  }
  if (!credentials) {
    // 退到 `.credentials.json`:它在 CLAUDE_CONFIG_DIR 里,fs 照不到那里就说不知道,❌ 读成 home 下那份别人的。
    if (configDir && !ctx.fsFollowsConfigRoot) throw new Error('无法读取所选 CLAUDE_CONFIG_DIR 的登录凭据。');
    credentials = await readJsonObject(ctx, '.claude/.credentials.json');
  }
  const token = objectAt(credentials, 'claudeAiOauth')?.accessToken;
  return typeof token === 'string' && token ? token : null;
}
