import { describe, expect, it } from 'vitest';
import { claudePresenceFile } from './presence';

// 2.1.301 实写的一份(2026-10-16 #7501 录制,只换掉了路径)。
const recorded = {
  pid: 48417,
  sessionId: '50c3a8de-73be-49ba-a937-886d24d6aa70',
  cwd: '/tmp/task-home',
  startedAt: 1792211131853,
  procStart: '665183010',
  version: '2.1.301',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  status: 'waiting',
  waitingFor: 'permission prompt',
  updatedAt: 1792211244192,
  statusUpdatedAt: 1792211244192,
};

describe('claude session presence file', () => {
  it('reads pid, session id and status from what 2.1.301 writes', () => {
    expect(claudePresenceFile.parse(JSON.stringify(recorded))).toEqual({
      pid: 48417,
      sessionId: '50c3a8de-73be-49ba-a937-886d24d6aa70',
      status: 'waiting',
    });
    for (const status of ['busy', 'idle', 'shell'] as const) {
      expect(claudePresenceFile.parse(JSON.stringify({ ...recorded, status })).status).toBe(status);
    }
  });

  it('lives at <CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json', () => {
    expect(claudePresenceFile).toMatchObject({ configDirEnvVar: 'CLAUDE_CONFIG_DIR', defaultConfigDirName: '.claude', directory: 'sessions' });
  });

  it('reads the config directory the process really uses from a hook transcript_path (a wrapper may set it in-process)', () => {
    const of = claudePresenceFile.configRootOfHook!;
    expect(of({ transcript_path: '/root/.rec/claude/accounts/53271/config/projects/-root-work/abc.jsonl' })).toBe('/root/.rec/claude/accounts/53271/config');
    expect(of({ transcript_path: '/home/u/.claude/projects/-home-u-p/abc.jsonl' })).toBe('/home/u/.claude');
    expect(of({ transcript_path: '/home/u/elsewhere/abc.jsonl' })).toBeNull();
    expect(of({})).toBeNull();
  });

  it('fails loud when the undocumented shape changes instead of guessing', () => {
    expect(() => claudePresenceFile.parse('{')).toThrow(/not JSON/);
    expect(() => claudePresenceFile.parse(JSON.stringify({ ...recorded, status: undefined }))).toThrow(/carries no status/);
    expect(() => claudePresenceFile.parse(JSON.stringify({ ...recorded, status: 'compacting' }))).toThrow(/"compacting" is not one gugu knows/);
    expect(() => claudePresenceFile.parse(JSON.stringify({ ...recorded, pid: '48417' }))).toThrow(/carries no pid/);
    expect(() => claudePresenceFile.parse(JSON.stringify({ ...recorded, sessionId: '' }))).toThrow(/carries no sessionId/);
  });
});
