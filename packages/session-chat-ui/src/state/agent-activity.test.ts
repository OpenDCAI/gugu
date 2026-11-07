import { describe, expect, it } from 'vitest';
import { defaultChatTranslator as translate } from '../localization';
import { unit, type SegmentCtx, type ItemSegmenter } from '../core/units';
import type { ChatMessage, TranscriptTurn } from '../model';
import { incomingActivity, outgoingActivity, foldActivityUnits, trailingActivity, appendActivityUnits } from './agent-activity';
import { flattenTier, makeUnitsView } from './flatten';
import { activitySummary, activitySummaryText } from './activity-summary';
import { createViewState } from './view-state';
import { latestViewerInput, resetActivityOnInput } from './activity-boundary';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const a = 'user:11111111-1111-4111-8111-111111111111', human = 'user:22222222-2222-4222-8222-222222222222';
const ctx: SegmentCtx = { actor: (id: string) => id === a ? { id, type: 'agent', name: 'd3' } : id === human ? { id, type: 'human', name: 'Owner' } : null,
  chatName: (id: string) => id === 'group' ? 'gugu' : null, translate, agentConversation: true, active: false, expanded: () => false,
  pendingToolCallIds: () => new Set(), terminalSnapshot: () => null, plan: () => null, caches: {} } as unknown as SegmentCtx;
const incoming = (id: string, type = 'agent', address = a) => ({ kind: 'message' as const, id, seq: 0, role: 'user' as const, text:
  `<gugu_delivery route="chat" chat="group" chat_kind="group" from="d3" from_id="${address}" from_type="${type}" msg="msg:${id}"><![CDATA[message ${id}]]></gugu_delivery>` });
const message = (id: string): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'assistant', text: id });
const turn = (id: string, items: ChatMessage[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });
const segmenters = Object.fromEntries(['message', 'turn-process', 'tool-run'].map(kind => [kind, { kind, segment: item => [unit(kind, item, item, { key: 'self' })] } satisfies ItemSegmenter]));

describe('agent activity identity and grouping', () => {
  it('joins incoming tool-only activity across hover-only completion controls', () => {
    const record = (id: string): TranscriptTurn => ({ ...turn(id, [incoming(`${id}-input`)]), items: [incoming(`${id}-input`),
      { kind: 'mcp-tool-call', id: `${id}-read`, toolCallId: `${id}-read`, seq: 1, title: 'Read history', server: 'gugu', tool: 'message_history', status: 'done',
        rawInput: JSON.stringify({ chat_id: 'group' }), outputText: '[]' }] });
    const all = { ...segmenters, 'turn-completion': { kind: 'turn-completion', segment: item => [unit('turn-completion', item, item, { key: 'self' })] } satisfies ItemSegmenter };
    const rows = flattenTier([record('one'), record('two')], ctx, all);
    const heads = rows.filter(row => row.kind === 'agent-activity');
    const footers = rows.filter(row => row.kind === 'turn-completion');
    expect(footers).toHaveLength(2);
    expect(heads).toHaveLength(1);
    const group = heads[0].data as import('./agent-activity').AgentActivityGroup;
    expect(group.events.reduce((sum,event) => sum + event.count, 0)).toBe(2);
    expect(footers.every(row => row.activityFold === heads[0].id)).toBe(true);
    expect(trailingActivity(rows)?.events).toHaveLength(2);
  });

  it('folds only authenticated agent inputs, leaving human, unknown and mixed deliveries readable', () => {
    expect(incomingActivity(incoming('a'), ctx)?.count).toBe(1);
    expect(incomingActivity(incoming('h', 'human', human), ctx)).toBeNull();
    expect(incomingActivity(incoming('u', '', 'user:unknown'), ctx)).toBeNull();
    expect(incomingActivity(incoming('legacy', ''), ctx)?.count).toBe(1);
    const mixed = { ...incoming('m'), text: incoming('a').text + '\n' + incoming('h', 'human', human).text };
    expect(incomingActivity(mixed, ctx)).toBeNull();
  });
  it('never treats unknown recipients or a group transport as an agent identity', () => {
    const addresses = { target: { kind: 'chat' as const, conversationId: 'group', threadRootId: null, whisper: false }, recipients: [a], chatKind: 'group', replyTo: null, confirmed: true };
    expect(outgoingActivity('s', addresses, ctx)?.count).toBe(1);
    for (const recipients of [[a, human], ['user:unknown'], null]) expect(outgoingActivity('s', { ...addresses, recipients }, ctx)).toBeNull();
    expect(outgoingActivity('s', { ...addresses, recipients: [] }, ctx)?.group?.name).toBe('gugu');
    expect(outgoingActivity('s', { ...addresses, confirmed: false }, ctx)).toMatchObject({ count: 0, direction: 'sending', live: true });
  });
  it.each(['sending', 'waiting', 'accepted', 'failed', 'unknown'] as const)('leaves the %s incoming receipt visible until custody clears', state => {
    expect(incomingActivity({ ...incoming('pending'), sendStatus: { state } }, ctx)).toBeNull();
  });
  it('classifies a receiving Agent from its first host receipt without delaying ordinary or human inputs', () => {
    expect(incomingActivity({ ...incoming('pending'), sendStatus: { state: 'receiving' } }, ctx)?.count).toBe(1);
    expect(incomingActivity({ ...incoming('human', 'human', human), sendStatus: { state: 'receiving' } }, ctx)).toBeNull();
    expect(incomingActivity({ ...incoming('ordinary'), text: 'Ordinary input', sendStatus: { state: 'receiving' } }, ctx)).toBeNull();
    const mixed = { ...incoming('batch'), text: incoming('agent').text + incoming('human', 'human', human).text,
      sendStatus: { state: 'receiving' as const } };
    expect(incomingActivity(mixed, ctx)).toBeNull();
  });
  it('uses structured delivery identity before presentation text, with text parsing only when facts are absent', () => {
    const agent = readDeliveryEnvelope(incoming('metadata-agent').text)!;
    expect(incomingActivity({ ...incoming('normalized'), text: 'Already normalized body', guguDelivery: agent,
      sendStatus: { state: 'receiving' } }, ctx)?.count).toBe(1);
    const person = readDeliveryEnvelope(incoming('metadata-human', 'human', human).text)!;
    expect(incomingActivity({ ...incoming('raw-agent'), guguDelivery: person, sendStatus: { state: 'receiving' } }, ctx)).toBeNull();
  });
  it('includes silent historic branches and their process under the same stable fold', () => {
    const records = [turn('old', [incoming('one'), { ...message('quiet'), text: '[NO_REPLY]' }]), turn('last', [incoming('two')])];
    const rows = flattenTier(records, ctx, segmenters);
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(1);
    const head = rows[0];
    expect(rows.filter(row => row.kind !== 'agent-activity').every(row => row.activityFold === head.id)).toBe(true);
    expect(activitySummaryText(activitySummary(head.data as import('./agent-activity').AgentActivityGroup, translate))).toBe('Received 2 messages from d3');
    expect((records[0].items[0] as ChatMessage).text).toContain('gugu_delivery');
  });
  it('joins committed, appended and streaming tiers without duplicating headers or counting the same event twice', () => {
    const event = incomingActivity(incoming('one'), ctx)!;
    const first = foldActivityUnits([{ ...unit('message', incoming('one'), incoming('one'), { key: 'self' }), activityEvent: event }]);
    const later = { ...incoming('two'), role: 'user' as const };
    const tail = foldActivityUnits([{ ...unit('message', later, later, { key: 'self' }), activityEvent: incomingActivity(later, ctx)! }], trailingActivity(first));
    expect(tail.some(row => row.kind === 'agent-activity')).toBe(false);
    expect((makeUnitsView(first, tail).at(0)!.data as import('./agent-activity').AgentActivityGroup).events).toHaveLength(2);
    expect((makeUnitsView(first, tail).at(0)!.data as import('./agent-activity').AgentActivityGroup).messageIds).toEqual(['one', 'two']);
    expect((appendActivityUnits(first, tail)[0].data as import('./agent-activity').AgentActivityGroup).events).toHaveLength(2);
    const duplicate = foldActivityUnits([{ ...unit('message', later, later, { key: 'self' }), activityEvent: event }, { ...unit('message', later, later, { key: 'self' }), activityEvent: event }]);
    expect((duplicate[0].data as import('./agent-activity').AgentActivityGroup).events).toHaveLength(1);
  });
  it('keeps every panel text between activity folds in its own original bubble', () => {
    const rows = flattenTier([turn('t', [incoming('one'), message('first'), message('second'), incoming('two')])], ctx, segmenters);
    for (const id of ['first', 'second']) {
      const row = rows.find(row => row.itemId === id)!;
      expect(row.activityFold).toBeUndefined();
      expect((row.data as ChatMessage).conversationNarration).toBeUndefined();
    }
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(2);
  });
  it('keeps unsuccessful completed sends outside the collapsed incoming process and confirmed count', () => {
    const call = { kind: 'mcp-tool-call' as const, id: 'send', toolCallId: 'send', seq: 1, title: 'Send', server: 'plugin_gugu-product_gugu',
      tool: 'message_send', status: 'done' as const, rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [a], text: 'reply' }), outputText: 'not delivered' };
    const record: TranscriptTurn = { ...turn('failed', [incoming('input')]), items: [...turn('failed', [incoming('input')]).items, call] };
    const rows = flattenTier([record], ctx, segmenters);
    const process = rows.find(row => row.kind === 'turn-process');
    expect(process).toBeDefined();
    expect(process?.activityFold).toBeUndefined();
    expect(rows.some(row => row.itemId.includes(':sent:'))).toBe(false);
    expect((rows.find(row => row.kind === 'agent-activity')?.data as import('./agent-activity').AgentActivityGroup).events.reduce((sum, event) => sum + event.count, 0)).toBe(1);
  });
  it('keeps an earlier failed process visible while folding a later successful agent reply', () => {
    const failed = { kind: 'mcp-tool-call' as const, id: 'failed', toolCallId: 'failed', seq: 1, title: 'Send', server: 'plugin_gugu-product_gugu',
      tool: 'message_send', status: 'error' as const, rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [a], text: 'failed reply' }), outputText: 'not delivered' };
    const success = { ...failed, id: 'success', toolCallId: 'success', seq: 2, status: 'done' as const,
      rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [a], text: 'delivered reply' }), outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' };
    const record: TranscriptTurn = { ...turn('retry', [incoming('input')]), items: [...turn('retry', [incoming('input')]).items, failed, success] };
    const rows = flattenTier([record], ctx, segmenters);
    expect(rows.find(row => row.itemId.includes('success:sent:'))?.activityFold).toBeDefined();
    expect(rows.find(row => row.itemId === 'retry:process:head')?.activityFold).toBeUndefined();
    expect(rows.filter(row => row.kind === 'agent-activity').flatMap(row => (row.data as import('./agent-activity').AgentActivityGroup).events)
      .filter(event => event.direction === 'sent').reduce((sum, event) => sum + event.count, 0)).toBe(1);
  });
  it('summarizes group destinations without attributing a broadcast to every mentioned recipient', () => {
    const group = { id: 'g', name: 'gugu', target: { kind: 'chat' as const, chatId: 'g' } };
    const d3 = { id: a, name: 'd3', target: { kind: 'sender' as const, userId: a.slice(5) } };
    const sent = { id: 'out', direction: 'sent' as const, group, actors: [d3], count: 1, live: false };
    const text = activitySummaryText(activitySummary({ id: 'x', events: [sent] }, translate));
    expect(text).toBe('Sent 1 message in gugu');
    const peers = ['g1', 'g2', 'g3'].map(id => ({ ...sent, id, group: { ...group, id, name: id } }));
    expect(activitySummaryText(activitySummary({ id: 'x', events: peers }, translate))).toContain('(3 groups)');
  });
  it('does not claim a distinct agent count when a remote session has no canonical owner yet', () => {
    const actors = [a, 'user:33333333-3333-4333-8333-333333333333', 'session:505adac7-1905-473b-8d2f-d574b6892518']
      .map((id, index) => ({ id, name: `Agent ${index}`, target: { kind: 'session' as const, sessionId: id } }));
    const events = actors.map((actor, index) => ({ id: String(index), direction: 'received' as const, actors: [actor], count: 1, live: false }));
    expect(activitySummaryText(activitySummary({ id: 'x', events }, translate))).toBe('Received 3 messages from Agent 0, Agent 1 and others (3 destinations)');
  });
  it('does not reset reading when the same owner input changes its native/live projection identity', () => {
    const original = { ...message('optimistic'), role: 'user' as const, _meta: { guguClientMessageId: 'client-input' } };
    const landed = { ...original, id: 'native:message:msg_actual' };
    expect(latestViewerInput([turn('one', [original])])).toBe(latestViewerInput([turn('two', [landed])]));
  });
  it('resets manual expansion only for a new viewer message, preserving initial mount and other human inputs', () => {
    const model = {}, view = createViewState(), id = 'agent-activity:one';
    view.setCollapsed(id, true);
    expect(resetActivityOnInput(model, 'old', view)).toBe(false);
    expect(resetActivityOnInput(model, 'old', view)).toBe(false);
    expect(view.isCollapsed(id)).toBe(true);
    expect(resetActivityOnInput(model, 'new', view)).toBe(true);
    expect(view.isCollapsed(id)).toBe(false);
    expect(latestViewerInput([turn('h', [incoming('other', 'human', human)])], 'someone', 'old')).toBe('old');
    expect(latestViewerInput([turn('h', [incoming('own', 'human', human)])], human)).toBe('msg:own');
  });
});
