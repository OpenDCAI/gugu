import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('local attachment table retirement', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('removes the unused table and index after all migrations', async () => {
    fixture = await openFixture('empty');
    expect(fixture.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('session_attachments', 'idx_session_attachments_session_id')"
    ).all()).toEqual([]);
  });
});
