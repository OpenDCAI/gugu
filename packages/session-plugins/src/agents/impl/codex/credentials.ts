import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { readJsonObject } from '../../helpers/subscription';

/** Official store selection, also used by cockpit-tools codex_account_authority_sync.rs. */
export async function readCodexCredentials(ctx: AgentAuthContext): Promise<Record<string, unknown> | null> {
  if (ctx.env.CODEX_HOME?.trim() && !ctx.fsFollowsConfigRoot) throw new Error('无法读取所选 CODEX_HOME 的登录凭据。');
  const configRaw = await ctx.fs.read('.codex/config.toml');
  const config = configRaw ? parseTOML(configRaw) : {};
  const store = config.cli_auth_credentials_store ?? 'file';
  if (store === 'ephemeral') return null;
  if (store === 'file') return readJsonObject(ctx, '.codex/auth.json');
  if (store !== 'keyring' && store !== 'auto') throw new Error('Codex 配置了无法识别的凭据存储。');
  if (process.platform !== 'darwin') throw new Error('当前系统的 Codex 钥匙串读取尚未接通。');
  const directory = ctx.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const root = await realpath(directory);
  const account = `cli|${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  let raw: string;
  try {
    ({ stdout: raw } = await ctx.exec('/usr/bin/security', ['find-generic-password', '-s', 'Codex Auth', '-a', account, '-w'], { timeout: 5_000 }));
  } catch (error) {
    if ((error as { code?: unknown }).code === 44) return store === 'auto' ? readJsonObject(ctx, '.codex/auth.json') : null;
    throw new Error('无法读取 Codex 的系统钥匙串。');
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex 登录凭据格式无效。');
  return value as Record<string, unknown>;
}
