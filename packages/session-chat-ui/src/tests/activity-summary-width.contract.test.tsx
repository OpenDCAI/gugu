/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
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
