/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
import { readableLabel } from '../components/rows/readable-label';
import { ACTIVITY_LABEL_INSET } from '../components/rows/agent-activity/activity-metrics';
import { activitySummary, activitySummaryText } from '../state/activity-summary';
import { activityUnitDef } from '../components/rows/agent-activity/activity.def';
import type { AgentActivityGroup } from '../state/agent-activity';
import { makeContractCtx, renderAndMeasureUnit } from './contract';
import { defaultChatTranslator } from '../localization';
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanup: Array<() => void> = [];
afterEach(() => { while(cleanup.length) cleanup.pop()?.(); });
const names = ['云端与计费主管（Claude，负责所有云端账户及账本结算）', '发版与 CI 主管（所有客户端平台构建与发布负责人）', '账号与用户主管（登录与用户基础设施负责人）'];

describe('narrow activity summary', () => {
 it.each([1,3])('preserves the count with %i long actor names at 390px', async actorCount => {
  const context=createChatContext({locale:()=> 'zh-CN',layout:{preset:'double',agentConversation:true,userGutter:0},
   actor:id=>({id,type:'agent',name:names[Number(id.slice(-1))-1]??names[0]}),
   translator:(key,values)=>{const template=(zhCNMessages as Record<string,string>)[key];return template?template.replace(/\{(\w+)\}/g,(_,k)=>String(values?.[k]??'')):defaultChatTranslator(key,values);}});
  const state=createChatState(context);
  const records=Array.from({length:37},(_,i):TranscriptTurn=>({id:`turn-${i}`,seq:i,initiator:'user',outcome:{kind:'done'},items:[{kind:'message',id:`incoming-${i}`,role:'user',seq:0,
   text:`<gugu_delivery route="chat" from="Agent" from_id="user:peer${i%actorCount+1}" from_type="agent" msg="msg:${i}"><![CDATA[Actual activity message]]></gugu_delivery>`}]}));
  state.transcript.history.seed(records);
  const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;top:0;left:0;width:390px;height:600px';
  const view=createChatView({context,state,parent:host,pinUserMessages:true,stickToBottom:false});
  cleanup.push(()=>{view.dispose();state.dispose();context.dispose();host.remove();});
  await until('summary mounted',()=>!!host.querySelector('[data-agent-activity]'));
  await untilStable('summary geometry',()=>host.querySelector('[data-agent-activity]')!.getBoundingClientRect().width);
  const row=host.querySelector<HTMLElement>('[data-agent-activity]')!, inline=row.lastElementChild as HTMLElement;
  const label=inline.children[1] as HTMLElement;
  const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);let node:Node|null;let countBox:DOMRect|undefined;
  while((node=walker.nextNode())) if(node.textContent?.includes('37')) {const range=document.createRange();range.selectNodeContents(node);countBox=range.getBoundingClientRect();}
  expect(countBox,'the semantic count must exist').toBeDefined();
  const box=label.getBoundingClientRect();
  expect(countBox!.left).toBeGreaterThanOrEqual(box.left-1);
  expect(countBox!.right,'the count must be inside the actual clipped label').toBeLessThanOrEqual(box.right+1);
  expect(label.scrollWidth,'the renderer must fit tokens before whole-line clipping').toBeLessThanOrEqual(label.clientWidth+1);
  expect(inline.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right+1);
  expect(label.textContent).toContain('37 条消息');
  expect(label.textContent).toContain('云端');
  if(actorCount>1) expect(label.textContent).toContain('等 3 个');
 });
});


const chinese = (key: string, values?: Readonly<Record<string, string | number>>) => {
 const template = (zhCNMessages as Record<string, string>)[key];
 return template ? template.replace(/\{(\w+)\}/g, (_, k) => String(values?.[k] ?? '')) : defaultChatTranslator(key, values);
};

describe.each([false, true])('three-line semantic summary (dark=%s)', dark => {
 it.each([
  { name: '云端与计费主管（Claude，负责云端账户及账本结算）', lines: 2, shortened: false },
  { name: '云端与计费主管（Claude，负责所有云端账户、账本结算、服务部署、价格目录以及跨设备故障排查和维护）', lines: 3, shortened: false },
  { name: '云端与计费主管（Claude，负责所有云端账户、账本结算、服务部署、价格目录以及跨设备故障排查和维护）'.repeat(3), lines: 3, shortened: true },
 ])('wraps to $lines lines before truncating (shortened=$shortened)', async ({ name, lines, shortened }) => {
  document.body.classList.toggle('emdark', dark);
  const actor = { id: 'user:cloud', name, target: { kind: 'sender' as const, userId: 'cloud' } };
  const group: AgentActivityGroup = { id: 'summary', events: [{ id: 'event', direction: 'received', actors: [actor], count: 37, live: false }], messageIds: [] };
  const ctx = makeContractCtx({ width: 390 }); ctx.translate = chinese;
  const reading = await renderAndMeasureUnit(activityUnitDef, group, ctx, host => {
   const row = host.querySelector<HTMLElement>('[data-agent-activity]')!;
   const label = row.lastElementChild!.children[1] as HTMLElement;
   const tops = new Set<number>(); const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
   let node: Node | null;
   while ((node = walker.nextNode())) for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
    const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
    if (node.textContent![i].trim()) tops.add(Math.round(range.getBoundingClientRect().top));
   }
   expect(label.textContent).toContain('37 条消息');
   expect(label.textContent).toContain('云端与计费主管');
   expect(label.textContent!.includes('…')).toBe(shortened);
   expect(row.querySelector('[data-activity-target]')?.getAttribute('aria-label')).toBe(name);
   return { lines: tops.size, overflow: Math.max(0, label.scrollWidth - label.clientWidth) };
  });
  expect(reading.inspected.lines).toBe(lines);
  expect(reading.computed).toBe(reading.dom);
  expect(reading.inspected.overflow).toBe(0);
  expect(reading.spill).toBe(0);
  document.body.classList.remove('emdark');
 });
});


it('preserves a hanging space when the count wraps before its unit', async () => {
 const actor = { id: 'user:cloud', name: '云端主管', target: { kind: 'sender' as const, userId: 'cloud' } };
 const group: AgentActivityGroup = { id: 'hanging-count', events: [{ id: 'event', direction: 'received', actors: [actor], count: 37, live: false }] };
 const sentence = activitySummaryText(activitySummary(group, chinese));
 const ctx = makeContractCtx({ width: 390 }); ctx.translate = chinese;
 // Find the actual font's wrap after "37 ", rather than assuming a machine-specific pixel width.
 const width = Array.from({ length: 300 }, (_, i) => i + 100).find(width =>
  readableLabel(sentence, ctx, width - ACTIVITY_LABEL_INSET, 12, 18, 400).text.includes('37 \n'));
 expect(width, 'the fixture must exercise a hanging count separator').toBeDefined();
 ctx.width = width!;
 const reading = await renderAndMeasureUnit(activityUnitDef, group, ctx, host => {
  const label = host.querySelector('[data-agent-activity]')!.lastElementChild!.children[1];
  expect(label.textContent).toBe(sentence);
  expect(label.textContent).toContain('37 条消息');
  return {};
 });
 expect(reading.dom).toBe(reading.computed);
 expect(reading.spill).toBe(0);
});

it.each(Array.from({ length: 49 }, (_, index) => index + 342))('keeps native Chinese punctuation inside a %ipx conversation', async width => {
 const actorNames = ['账号与用户主管（Claude，d22）', '手机线协调（Codex）', '第三位协作者'];
 const context = createChatContext({ locale: () => 'zh-CN', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
  actor: id => ({ id, type: 'agent', name: actorNames[Number(id.slice(-1))] }), translator: chinese });
 const state = createChatState(context);
 state.transcript.history.seed(actorNames.map((_, index): TranscriptTurn => ({ id: `native-turn-${index}`, seq: index,
  initiator: 'user', outcome: { kind: 'done' }, items: [{ kind: 'message', id: `native-input-${index}`, seq: 0, role: 'user',
   text: `<gugu_delivery route="chat" from="Agent" from_id="user:actor${index}" from_type="agent" msg="msg:${index}"><![CDATA[Agent update]]></gugu_delivery>` }] })));
 const host = document.body.appendChild(document.createElement('div'));
 host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:600px`;
 const view = createChatView({ context, state, parent: host, stickToBottom: false });
 cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
 await until('native semantic summary', () => !!host.querySelector('[data-agent-activity]'));
 await untilStable('native summary geometry', () => host.querySelector('[data-agent-activity]')!.getBoundingClientRect().width);
 const label = host.querySelector('[data-agent-activity]')!.lastElementChild!.children[1] as HTMLElement;
 const lines = [...label.children].map(line => ({ text: line.textContent, width: line.getBoundingClientRect().width,
  painted: [...line.children].reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) }));
 console.log(JSON.stringify({ font: getComputedStyle(label).font, lines }));
 expect(label.textContent).toContain('手机线协调（Codex）');
 expect(lines.length).toBeLessThanOrEqual(3);
 expect(Math.ceil(Math.max(...lines.map(line => line.painted)))).toBeLessThanOrEqual(label.clientWidth);
 expect(label.scrollWidth, 'native punctuation must not push an actor letter outside the label').toBeLessThanOrEqual(label.clientWidth);
});
