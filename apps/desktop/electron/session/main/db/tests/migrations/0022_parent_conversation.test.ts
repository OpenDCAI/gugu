import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0022 parent conversation metadata', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>> | undefined;

  afterEach(() => {
    fixture?.close();
  });

  it('adds indexed nullable self-references that clear when their source is deleted', async () => {
    fixture = await openFixture('baseline', { through: '0022_cultured_war_machine' });
    const { sqlite } = fixture;

    sqlite
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run('project-1', 'Project 1', '/tmp/project-1');
    sqlite
      .prepare('INSERT INTO tasks (id, project_id, name, status) VALUES (?, ?, ?, ?)')
      .run('task-1', 'project-1', 'Task 1', 'running');

    sqlite
      .prepare('INSERT INTO conversations (id, project_id, task_id, title) VALUES (?, ?, ?, ?)')
      .run('parent', 'project-1', 'task-1', 'Parent');
    sqlite
      .prepare(
        'INSERT INTO conversations (id, project_id, task_id, title, parent_conversation_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run('child', 'project-1', 'task-1', 'Child', 'parent');

    sqlite
      .prepare('UPDATE conversations SET spawned_by_conversation_id = ? WHERE id = ?')
      .run('parent', 'child');

    const foreignKeys = sqlite.prepare('PRAGMA foreign_key_list(conversations)').all() as Array<{
      from: string;
      on_delete: string;
    }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'parent_conversation_id', on_delete: 'SET NULL' }),
        expect.objectContaining({ from: 'spawned_by_conversation_id', on_delete: 'SET NULL' }),
      ])
    );

    const indexes = sqlite.prepare('PRAGMA index_list(conversations)').all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain(
      'idx_conversations_parent_conversation_id'
    );
    expect(indexes.map((index) => index.name)).toContain(
      'idx_conversations_spawned_by_conversation_id'
    );

    sqlite.prepare('DELETE FROM conversations WHERE id = ?').run('parent');
    const child = sqlite
      .prepare(
        'SELECT parent_conversation_id, spawned_by_conversation_id FROM conversations WHERE id = ?'
      )
      .get('child') as {
      parent_conversation_id: string | null;
      spawned_by_conversation_id: string | null;
    };
    expect(child.parent_conversation_id).toBeNull();
    expect(child.spawned_by_conversation_id).toBeNull();
  });
});
