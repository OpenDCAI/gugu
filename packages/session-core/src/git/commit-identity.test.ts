import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createBoundExec } from '../exec';
import { classifyCommitError } from './errors';

const run = promisify(execFile);

// #6264 新服务器上没配 git 身份:审阅页的「提交」要认出这件事(界面据此就地问名字邮箱),❌ 甩出英文原文。
describe('commit without a git identity', () => {
  it('a real `git commit` on a machine with no user.name/email classifies as identity_unknown', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-ident-'));
    try {
      const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', LANG: 'C' };
      await run('git', ['init', '-q', home], { env });
      fs.writeFileSync(path.join(home, 'a.txt'), 'x');
      await run('git', ['add', 'a.txt'], { cwd: home, env });
      // useConfigOnly:不许 git 拿 user@hostname 凑一个(与「最小化服务器上凑不出」同一个结局,且与主机名无关)。
      const exec = createBoundExec({ file: 'git', cwd: home, env });
      const error = await exec.exec(['-c', 'user.useConfigOnly=true', 'commit', '-m', 'm']).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).not.toBeNull();
      expect(classifyCommitError(error).type).toBe('identity_unknown');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('other failures are not mistaken for it', () => {
    expect(classifyCommitError(new Error('nothing to commit, working tree clean')).type).toBe('nothing_to_commit');
  });
});
