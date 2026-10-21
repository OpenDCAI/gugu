import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

/**
 * 0035:会话的权限只剩 permissionMode。存量的 autoApprove 布尔按 permissionModeFromAutoApprove 那张表折成档位
 * (true ⇒ full-access,false ⇒ edit),已有档位的以档位为准,然后删掉布尔;其余键原样。
 * 种子按 0034 之后的形状写,再只跑 0035 这一个文件。
 */
const MIGRATION = bundledMigrations().find((migration) => migration.tag === '0035_permission_mode_only');

const initialSession = (extra: Record<string, unknown>) =>
  JSON.stringify({
    version: '1',
    sessionConfig: { version: '1', name: 'Daily', initialSession: { id: 's', provider: 'claude', ...extra } },
    workspaceConfig: { version: '1', kind: 'local' },
  });

describe('0035 permission mode only', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('折布尔成档位,有档位的不改,删掉布尔,其余键原样', async () => {
    fixture = await openFixture('empty', { through: '0034_agent_schedules' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, config) VALUES
        ('on', 'p1', 'T', 'claude', '{"version":"1","type":"pty","autoApprove":true,"model":"opus"}'),
        ('off', 'p1', 'T', 'claude', '{"version":"1","type":"acp","autoApprove":false}'),
        ('both', 'p1', 'T', 'claude', '{"version":"1","type":"pty","autoApprove":false,"permissionMode":"read-only"}'),
        ('none', 'p1', 'T', 'claude', '{"version":"1","type":"pty","model":"opus"}');
      INSERT INTO automations (id, name, session_config, created_at, updated_at) VALUES
        ('a1', 'A', '${initialSession({ autoApprove: true })}', 1, 1);
      INSERT INTO automation_runs (id, automation_id, status, trigger_kind, session_config_snapshot) VALUES
        ('r1', 'a1', 'done', 'cron', '${initialSession({ autoApprove: false, permissionMode: 'plan' })}');
    `);
    expect(MIGRATION).toBeDefined();
    applyMigrations(sql, [MIGRATION!]);

    const config = (id: string) =>
      JSON.parse((sql.prepare(`SELECT config FROM sessions WHERE id = ?`).get(id) as { config: string }).config);
    expect(config('on')).toEqual({ version: '1', type: 'pty', permissionMode: 'full-access', model: 'opus' });
    expect(config('off')).toEqual({ version: '1', type: 'acp', permissionMode: 'edit' });
    expect(config('both')).toEqual({ version: '1', type: 'pty', permissionMode: 'read-only' });
    // 阴控:没有布尔的行一个键都不动(不凭空长出档位)。
    expect(config('none')).toEqual({ version: '1', type: 'pty', model: 'opus' });

    const automation = JSON.parse(
      (sql.prepare(`SELECT session_config FROM automations WHERE id = 'a1'`).get() as { session_config: string }).session_config,
    );
    expect(automation.sessionConfig.initialSession).toEqual({ id: 's', provider: 'claude', permissionMode: 'full-access' });
    const run = JSON.parse(
      (sql.prepare(`SELECT session_config_snapshot FROM automation_runs WHERE id = 'r1'`).get() as { session_config_snapshot: string })
        .session_config_snapshot,
    );
    expect(run.sessionConfig.initialSession).toEqual({ id: 's', provider: 'claude', permissionMode: 'plan' });
  });
});
