import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 0028:会话历史落盘(#5381)。
 *
 * 存在理由:从前会话页不存对话内容,历史唯一来源是恢复时的 ACP `session/load` 重放,
 * 而重放完不完整取决于 provider —— 实测 claude 的适配器在上下文压缩之后只重放最后一次
 * 压缩边界之后的部分,压缩前的消息就永久离开了界面。
 *
 * `seq` 由主进程按到达序分配,**不复用运行时那份回合序号**:重开会话后运行时从 0 重数,
 * 而重放只含压缩后的一段,直接拿它当键必然与库里已有的行撞号。下面第二条用例守的就是这件事。
 */
describe('0028 conversation_turns', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  function seedConversation(): void {
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(`INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'T', 'in_progress')`)
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, task_id, title) VALUES ('c1', 'p1', 't1', 'C')`
      )
      .run();
  }

  it('建出了这张表,一条回合一行,按 seq 取回原顺序', async () => {
    fixture = await openFixture('empty', { through: '0028_conversation_turns' });
    seedConversation();

    const insert = fixture.sqlite.prepare(
      `INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES (?, 'c1', ?, ?, ?)`
    );
    insert.run('c1:0', 0, 'c1:turn:0', JSON.stringify({ items: [{ kind: 'message', text: '第一轮' }] }));
    insert.run('c1:1', 1, 'c1:turn:1', JSON.stringify({ items: [{ kind: 'tool-call', name: 'bash' }] }));

    const rows = fixture.sqlite
      .prepare(`SELECT id, seq, turn_id, data FROM conversation_turns WHERE conversation_id = 'c1' ORDER BY seq`)
      .all() as { id: string; seq: number; turn_id: string; data: string }[];

    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(JSON.parse(rows[0].data).items[0].text).toBe('第一轮');
    expect(rows[1].turn_id).toBe('c1:turn:1');
  });

  /**
   * 阳控:这正是「不能拿运行时的回合序号当键」的那一撞。重开会话后运行时的序号从 0 重数,
   * 若写入方把它原样当 `seq`/`id`,第二段历史就会盖掉第一段——用户看到的是「更早的消息不见了」,
   * 和压缩截断长得一模一样,却是我们自己造成的。
   */
  it('同一条会话里 id 唯一,重复写入撞主键而不是静默覆盖', async () => {
    fixture = await openFixture('empty', { through: '0028_conversation_turns' });
    seedConversation();

    const insert = fixture.sqlite.prepare(
      `INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES (?, 'c1', ?, ?, '{}')`
    );
    insert.run('c1:0', 0, 'c1:turn:0');

    expect(() => insert.run('c1:0', 0, 'c1:turn:0')).toThrow();
  });

  it('会话删掉时历史跟着走', async () => {
    fixture = await openFixture('empty', { through: '0028_conversation_turns' });
    seedConversation();
    fixture.sqlite
      .prepare(
        `INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data) VALUES ('c1:0', 'c1', 0, 'c1:turn:0', '{}')`
      )
      .run();

    fixture.sqlite.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();

    const left = fixture.sqlite
      .prepare(`SELECT count(*) AS n FROM conversation_turns`)
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('❌ 不许挂在一个不存在的会话下', async () => {
    // 阳控:外键没生效的话这一行会插进去,上面那条 cascade 也就成了空话。
    fixture = await openFixture('empty', { through: '0028_conversation_turns' });

    expect(() =>
      fixture.sqlite
        .prepare(
          `INSERT INTO conversation_turns (id, conversation_id, seq, turn_id, data)
           VALUES ('x:0', 'no-such-conversation', 0, 'x:turn:0', '{}')`
        )
        .run()
    ).toThrow();
  });
});
