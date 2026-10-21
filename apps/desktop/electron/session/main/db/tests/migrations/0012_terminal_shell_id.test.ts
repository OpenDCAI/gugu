import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0012 terminal shell id migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('backfills existing terminal rows to system', async () => {
    fixture = await openFixture('pre-0012');

    const row = fixture.sqlite
      .prepare(`SELECT shell_id FROM terminals WHERE id = 'pre-0012-terminal-1'`)
      .get() as { shell_id: string } | undefined;

    expect(row?.shell_id).toBe('system');
  });
});
