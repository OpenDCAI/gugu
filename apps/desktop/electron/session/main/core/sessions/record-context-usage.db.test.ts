/**
 * #7342 通用模式会话停下后,输入框还要画得出最后那份上下文读数 —— 读数得落进会话记录。
 *
 * 判据两半:
 * - `contextUsageChange`(纯判据):一轮落定才写、流式中不写、读数要属于此刻的模型、换了模型作废;
 * - 落库:只动 `config.contextUsage` 这一格(别的事实原样留着),盖上此刻行上的原生会话 id,经 `session:changed` 发出去。
 *
 * 能判假:把 `contextUsageChange` 里的 `!summary.isGenerating` 去掉,「流式中不写」当场红;
 * 去掉「只认启动落定后」那一行,「重放窗口里模型在过渡」当场红(都是 mac1 实测)。
 */
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn, error: vi.fn() } }));

import { applyContextUsageChange, contextUsageChange, readRecordedContextUsage } from './record-context-usage';

const atRest = { lifecycle: 'ready' as const, isGenerating: false, contextTokens: 42_000, contextSize: 200_000, contextModelId: 'gpt-5.5', modelId: 'gpt-5.5' };

describe('contextUsageChange —— 要不要改记录里的读数', () => {
  it('一轮落定、读数齐、属于此刻的模型:写', () => {
    expect(contextUsageChange(null, atRest)).toEqual({
      kind: 'write',
      reading: { used: 42_000, size: 200_000, modelId: 'gpt-5.5' },
    });
  });

  it('流式中不写:摘要每个 token 都在变,一轮只写一次', () => {
    expect(contextUsageChange(null, { ...atRest, isGenerating: true })).toBeNull();
  });

  it('与记录那份相同:不写(同一轮的后续摘要不再撞库)', () => {
    expect(contextUsageChange({ used: 42_000, size: 200_000, modelId: 'gpt-5.5' }, atRest)).toBeNull();
  });

  it('读数齐但不全(引擎没报上限):不写', () => {
    expect(contextUsageChange(null, { ...atRest, contextSize: null })).toBeNull();
  });

  it('热切之后、新读数到之前:手里那份是旧模型量的 —— 不写,记录里旧模型那份作废', () => {
    const switched = { ...atRest, modelId: 'gpt-5.5-mini' };
    expect(contextUsageChange(null, switched)).toBeNull();
    expect(contextUsageChange({ used: 42_000, size: 200_000, modelId: 'gpt-5.5' }, switched)).toEqual({ kind: 'clear' });
  });

  it('重开成了别的模型、还没读数:作废', () => {
    const reopened = { lifecycle: 'ready' as const, isGenerating: false, contextTokens: null, contextSize: null, contextModelId: null, modelId: 'gpt-5.5-mini' };
    expect(contextUsageChange({ used: 1, size: 2, modelId: 'gpt-5.5' }, reopened)).toEqual({ kind: 'clear' });
  });

  it('重开时的重放窗口里模型在过渡(先报引擎默认、再设回记录那个):不作废、不写(mac1 真机实撞)', () => {
    const recorded = { used: 26_647, size: 828_400, modelId: 'gpt-5.6-terra' };
    for (const lifecycle of ['starting', 'replaying'] as const) {
      expect(contextUsageChange(recorded, { ...atRest, lifecycle, contextModelId: 'gpt-5.5', modelId: 'gpt-5.5' })).toBeNull();
    }
    // 阳性对照:同一份摘要落定之后,换了模型就作废 —— 判据没被整个关掉。
    expect(
      contextUsageChange(recorded, { ...atRest, contextTokens: null, contextSize: null, contextModelId: null, modelId: 'gpt-5.5' })
    ).toEqual({ kind: 'clear' });
  });

  it('阴控 —— 模型还说不出(引擎不报):不作废', () => {
    const starting = { lifecycle: 'ready' as const, isGenerating: false, contextTokens: null, contextSize: null, contextModelId: null, modelId: null };
    expect(contextUsageChange({ used: 1, size: 2, modelId: 'gpt-5.5' }, starting)).toBeNull();
  });
});

describe('落库', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const config = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: '1', type: 'acp', model: 'gpt-5.5', firstUtterance: '你好', ...extra });
  const row = (id: string) =>
    JSON.parse(
      (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string }).config
    ) as Record<string, unknown>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    mocks.warn.mockReset();
    fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');`);
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, provider_session_id, config)
         VALUES (?, 'project-1', 't', 'codex', ?, ?, ?)`
      )
      .run('acp-1', 'acp', 'native-1', config());
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, provider_session_id, config)
         VALUES (?, 'project-1', 't', 'codex', ?, ?, ?)`
      )
      .run('pty-1', 'pty', 'native-9', JSON.stringify({ version: '1', type: 'pty' }));
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('写:只动这一格,盖上原生会话 id,发 session:changed', () => {
    applyContextUsageChange('acp-1', { kind: 'write', reading: { used: 42_000, size: 200_000, modelId: 'gpt-5.5' } });
    const written = { used: 42_000, size: 200_000, modelId: 'gpt-5.5', providerSessionId: 'native-1' };
    expect(row('acp-1')).toMatchObject({ model: 'gpt-5.5', firstUtterance: '你好', contextUsage: written });
    expect(mocks.emit).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'acp-1',
      projectId: 'project-1',
      changes: { contextUsage: written },
    });
    expect(readRecordedContextUsage('acp-1')).toEqual(written);
  });

  it('作废:删键,别的事实原样留着,发 `null`(过得了 JSON)', () => {
    fixture.sqlite
      .prepare('UPDATE sessions SET config = ? WHERE id = ?')
      .run(config({ contextUsage: { used: 1, size: 2, modelId: 'gpt-5.5', providerSessionId: 'native-1' } }), 'acp-1');
    applyContextUsageChange('acp-1', { kind: 'clear' });
    expect(row('acp-1')).not.toHaveProperty('contextUsage');
    expect(row('acp-1')).toMatchObject({ model: 'gpt-5.5', firstUtterance: '你好' });
    expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ changes: { contextUsage: null } });
  });

  it('原生会话换了(重来):旧读数不算它的', () => {
    fixture.sqlite
      .prepare('UPDATE sessions SET config = ?, provider_session_id = ? WHERE id = ?')
      .run(config({ contextUsage: { used: 1, size: 2, modelId: 'gpt-5.5', providerSessionId: 'native-1' } }), 'native-2', 'acp-1');
    expect(readRecordedContextUsage('acp-1')).toBeNull();
  });

  it('不是通用模式的行 / 行已删:不写、不发,响亮记一行', () => {
    applyContextUsageChange('pty-1', { kind: 'write', reading: { used: 1, size: 2, modelId: null } });
    applyContextUsageChange('gone', { kind: 'write', reading: { used: 1, size: 2, modelId: null } });
    expect(row('pty-1')).not.toHaveProperty('contextUsage');
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
