/**
 * #4981 —— 别的 agent 投递进来的那条不占「人刚发言」的身份。
 *
 * owner 2026-09-06:「别的 agent 给这个 agent 发的信息其实也是通知,也不应该计入消息,
 * 更不应该有 stick 效果」。
 *
 * 「stick 效果」在代码里是两处同一个身份带来的:
 *   · `collectUserTurnUnits` 收出来的那批下标 = **钉到顶端**的名单(pin overlay);
 *   · 「最后一条用户消息」还会触发底部预留,把视图拽过去。
 * 投递卡照旧显示,只是不再占这个身份。
 *
 * 判据只喂给函数本身(合成条目),❌ 不去真系统里造一条投递。
 */
import { describe, expect, it } from 'vitest';
import { collectUserTurnUnits, isDeliveredFromAgent, makeUnitsView } from './flatten';
import type { ChatItem } from '../model';
import type { TranscriptTurn } from '../model';

const DELIVERY = [
  '<gugu_delivery route="chat" from="小雨" from_id="u_42" msg="m1" at="2026-09-06T08:00:00Z">',
  '<![CDATA[帮我看下这个]]>',
  '</gugu_delivery>',
].join('\n');

function message(id: string, role: 'user' | 'assistant', text: string): ChatItem {
  return { kind: 'message', id, seq: 0, role, text } as unknown as ChatItem;
}

function turnOf(items: ChatItem[]): TranscriptTurn {
  return { id: 't1', seq: 0, initiator: 'user', items } as unknown as TranscriptTurn;
}

/** 一个下标一条条目的最小 UnitsView —— 判据只关心「哪些条目进了名单」。 */
function unitsOf(items: ChatItem[]) {
  return makeUnitsView(
    items.map((item, i) => ({ kind: 'message', itemId: item.id, index: i }) as never),
    [] as never
  );
}

describe('#4981 投递进来的不是人打的字', () => {
  it('认得出信封与两种退役写法', () => {
    expect(isDeliveredFromAgent(message('a', 'user', DELIVERY))).toBe(true);
    // #6822 读方读不出的信封(这里截断了)也不冒充人说的话:它仍是投递。
    expect(isDeliveredFromAgent(message('t', 'user', DELIVERY.slice(0, 60)))).toBe(true);
    const origin = { source: 'session-direct', sender_session_id: 'session:p', message_id: 'msg:m', kind: 'message' };
    expect(
      isDeliveredFromAgent(message('b', 'user', `[gugu_session session-direct]\norigin=${JSON.stringify(origin)}\n正文`))
    ).toBe(true);
    expect(
      isDeliveredFromAgent(
        message(
          'c',
          'user',
          '[route="session-direct" from="A" from_id="session:a" msg="msg:a" at="t"]甲\n'
            + '[route="session-direct" from="B" from_id="session:b" msg="msg:b" at="t"]乙'
        )
      )
    ).toBe(true);
  });

  /**
   * ❌ 阴控:人自己打的字必须**不是**投递 —— 否则这个判据把所有用户消息一起排除掉,
   * 「不钉投递卡」就变成了「谁都不钉」,而 pin 是产品要的功能。
   */
  it('❌ 阴控:人打的字不算投递,连长得像的也不算', () => {
    expect(isDeliveredFromAgent(message('d', 'user', '帮我看下这个'))).toBe(false);
    // 引用了信封原文的一条人类消息:开头不是信封,不该被认成投递。
    expect(isDeliveredFromAgent(message('e', 'user', `我贴一下原文:\n${DELIVERY}`))).toBe(false);
    expect(isDeliveredFromAgent(message('f', 'assistant', DELIVERY))).toBe(false);
  });

  it('投递卡不进「钉到顶端」的名单', () => {
    const items = [message('m1', 'user', DELIVERY), message('m2', 'assistant', '好的')];
    expect(collectUserTurnUnits([turnOf(items)], unitsOf(items))).toEqual([]);
    // 但「钉顶在哪儿让位」要算上它(对话布局里它是右侧一个气泡,前一条的钉顶副本 ❌ 盖过它,MBP 验收 10-28)。
    expect(collectUserTurnUnits([turnOf(items)], unitsOf(items), { delivered: true })).toEqual([0]);
  });

  /**
   * ❌ 阳控:同样两条,只把投递信封换成人打的字 —— 只差这一个自由度。
   * 它必须进名单,否则上一条的「空」只是「这个函数什么都收不到」。
   */
  it('❌ 阳控:换成人打的字就进名单', () => {
    const items = [message('m1', 'user', '帮我看下这个'), message('m2', 'assistant', '好的')];
    expect(collectUserTurnUnits([turnOf(items)], unitsOf(items))).toEqual([0]);
  });
});
