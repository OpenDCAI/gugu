import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureAgentHome, resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { antigravitySessionBundleDescriptor } from './session-bundle';

it('leaves IDE brain/scratch behind while preserving CLI/ACP configuration, credentials, skills and records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-antigravity-config-'));
  try {
    const source = join(root, 'user/.gemini');
    const keep = ['config/skills/example/SKILL.md', 'config/hooks.json', 'config/mcp_config.json',
      'antigravity-cli/settings.json', 'antigravity-cli/antigravity-oauth-token',
      'antigravity-acp/settings.json', 'antigravity-acp/acp_token.json',
      'antigravity-acp/brain/session.json', 'antigravity-acp/conversations/session.json'];
    for (const p of [...keep, 'antigravity/brain/project/scratch/app.asar']) {
      await mkdir(dirname(join(source, p)), { recursive: true });
      await writeFile(join(source, p), p);
    }
    const home = resolveAgentHome({ providerId: 'antigravity',
      injectionMode: antigravitySessionBundleDescriptor.injectionMode,
      configRoot: antigravitySessionBundleDescriptor.configRoot,
      guguHome: join(root, 'gugu'), osHomeDir: join(root, 'user'), sourceEnv: {},
    })!;
    expect(await ensureAgentHome(home)).toBe('copied');
    for (const p of keep) expect(await readFile(join(home.configRoot, p), 'utf8')).toBe(p);
    await expect(stat(join(home.configRoot, 'antigravity/brain'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'antigravity/brain/project/scratch/app.asar'), 'utf8')).toBe('antigravity/brain/project/scratch/app.asar');
  } finally { await rm(root, { recursive: true, force: true }); }
});
