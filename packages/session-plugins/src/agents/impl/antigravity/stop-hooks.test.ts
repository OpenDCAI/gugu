import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStopCommands, parseDecision, runAntigravityStopHooks } from './stop-hooks';

function setup(opts: { global?: unknown; workspace?: unknown; trusted?: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-stop-')));
  const home = join(root, 'home');
  const cwd = join(root, 'ws');
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(join(home, 'antigravity-acp'), { recursive: true });
  mkdirSync(join(cwd, '.agents'), { recursive: true });
  if (opts.global) writeFileSync(join(home, 'config', 'hooks.json'), JSON.stringify(opts.global));
  if (opts.workspace) writeFileSync(join(cwd, '.agents', 'hooks.json'), JSON.stringify(opts.workspace));
  if (opts.trusted) {
    writeFileSync(join(home, 'antigravity-acp', 'trusted_workspaces.json'), JSON.stringify({ trusted: [cwd] }));
  }
  return { cwd, env: { GEMINI_HOME: home }, homeDir: '/nowhere', providerSessionId: 's-1', executionNum: 1 };
}

const say = (json: object) => `printf '%s' '${JSON.stringify(json)}'`;

describe('Antigravity Stop hooks, run by Gugu per turn (#6335)', () => {
  it('第一条 continue 短路,reason 作为下一条消息', async () => {
    const ctx = setup({
      global: {
        quiet: { Stop: [{ command: 'true' }] },
        nag: { Stop: [{ hooks: [{ command: say({ decision: 'continue', reason: 'write a summary' }) }] }] },
        later: { Stop: [{ command: say({ decision: 'continue', reason: 'never reached' }) }] },
      },
    });
    await expect(runAntigravityStopHooks(ctx)).resolves.toEqual({ continueWith: 'write a summary' });
  });

  it('stdin 收到它契约里的字段', async () => {
    const ctx = setup({ global: { echo: { Stop: [{ command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({decision:'continue',reason:j.conversationId+':'+j.executionNum+':'+j.fullyIdle}))})"` }] } } });
    await expect(runAntigravityStopHooks({ ...ctx, executionNum: 3 })).resolves.toEqual({ continueWith: 's-1:3:true' });
  });

  it('enabled:false 的组跳过;没有决定 ⇒ null', async () => {
    const ctx = setup({ global: { off: { enabled: false, Stop: [{ command: say({ decision: 'continue', reason: 'x' }) }] } } });
    await expect(runAntigravityStopHooks(ctx)).resolves.toBeNull();
  });

  it('工作区的钩子只在工作区被信任时跑(与它同一份 trusted_workspaces.json)', async () => {
    const workspace = { ws: { Stop: [{ command: 'echo ws' }] } };
    expect(await loadStopCommands(setup({ workspace }))).toEqual([]);
    expect(await loadStopCommands(setup({ workspace, trusted: true }))).toEqual([{ command: 'echo ws' }]);
  });

  it('parseDecision 只认 continue + 非空 reason', () => {
    expect(parseDecision('{"decision":"continue","reason":" go "}')).toBe('go');
    expect(parseDecision('{"decision":"stop","reason":"x"}')).toBeNull();
    expect(parseDecision('{"decision":"continue"}')).toBeNull();
    expect(parseDecision('not json')).toBeNull();
  });
});
