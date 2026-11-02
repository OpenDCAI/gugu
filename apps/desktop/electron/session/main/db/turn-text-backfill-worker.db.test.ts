import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { runTurnTextBackfill } from './turn-text-backfill-work';
import { registerSearchText } from './initialize';
import type { SearchProgress } from '@gugu/core/cloud/serverTransition';

let fixture: FixtureDb | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

describe('worker backfill uses the shared live projection', () => {
  it('reports measured work, preserves concurrent live edits, and resumes an interrupted cursor', async () => {
    fixture = await openFixture('empty');
    const db = fixture.sqlite;
    db.exec(`INSERT INTO projects(id,name,path) VALUES ('p','P','/repo');
      INSERT INTO sessions(id,project_id,config) VALUES ('s','p','{"version":"1","type":"acp"}');`);
    const turn = (n: number, text = 'historical searchable') => JSON.stringify({ id: `s:t:${n}`, referenceId: `source:${n}`, items: [{ kind: 'message', id: `s:t:${n}:message:0`, role: 'user', text }] });
    const insert = db.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,\'s\',?,?,?)');
    db.transaction(() => { for (let n = 0; n < 211; n++) insert.run(`row${n}`, n, `turn${n}`, turn(n)); })();
    db.exec(`DELETE FROM turn_text_rows; DELETE FROM kv WHERE key IN ('turn_text_backfilled','turn_text_backfill_cursor');`);
    const live = new Database(db.name); registerSearchText(live); live.pragma('busy_timeout=100');
    const progress: SearchProgress[] = [];
    try {
      const work = runTurnTextBackfill(db, p => progress.push(p));
      // The source service can use another connection before any historical turn is processed.
      expect(live.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 1 });
      live.prepare('UPDATE session_turns SET data=? WHERE seq=200').run(turn(200, 'live replacement searchable'));
      await work;
      expect(db.prepare('SELECT count(*) n FROM turn_text_rows').get()).toEqual({ n: 211 });
      expect(db.prepare('SELECT item_id,text FROM turn_text_rows WHERE seq=200').get()).toMatchObject({ text: 'live replacement searchable' });
      expect(progress[0]).toEqual({ state: 'running', done: 0, total: 211 });
      expect(progress.at(-1)).toEqual({ state: 'complete', done: 211, total: 211 });
      await runTurnTextBackfill(db, p => progress.push(p));
      expect(db.prepare('SELECT count(*) n FROM turn_text_rows').get()).toEqual({ n: 211 });
    } finally { live.close(); }
  });
});
