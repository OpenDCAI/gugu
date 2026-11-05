/** @jsxImportSource solid-js */
import { expect, it, vi } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { UNIT_REGISTRY } from '@session-chat/components/engine/unit-registry';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { until } from '../../../../tests/support/awaitCondition';
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
for (const hidden of [false,true]) it(`nested process pauses measurement hidden=${hidden}`,async()=>{
 const context=createChatContext({locale:()=> 'en-US'});
 context.setLayout({preset:'double',userGutter:72,agentConversation:true});
 const state=createChatState(context);
 const host=document.body.appendChild(document.createElement('div'));
 host.style.cssText='position:fixed;inset:0;width:800px;height:800px';
 const view=createChatView({context,state,parent:host});
 const write=(version:number)=>state.transcript.activeTurn.set({id:'scroll',seq:0,initiator:'user',
  items:Array.from({length:14},(_,i)=>({kind:'message',id:`say-${i}`,seq:i,role:i===0?'user':'assistant',
    text:`Process item ${i}, version ${version}`} as ChatMessage))} as TranscriptTurn,'generating');
 try{
  write(0);
  await until('real nested process mounts',()=>!!host.querySelector('[data-slot="conversation-process-steps"]'));
  await document.fonts.ready;await frame();await frame();
  if(hidden){view.setShown(false);Object.assign(host.style,RETAINED_SURFACE_HIDDEN_STYLE);}
  await frame();await frame();
  const defs=[...new Set(Object.values(UNIT_REGISTRY))];
  const spies=defs.map(def=>vi.spyOn(def,'measure'));
  for(let n=1;n<=8;n++){write(n);await frame();await frame();}
  const measured=spies.reduce((sum,s)=>sum+s.mock.calls.length,0);
  console.info(JSON.stringify({hidden,measured,childVisible:host.firstElementChild?.checkVisibility(),byKind:defs.map((d,i)=>[d.kind,spies[i].mock.calls.length]).filter(([,n])=>Number(n)>0)}));
  if(hidden){
   expect(host.firstElementChild?.checkVisibility()).toBe(false);expect(measured).toBe(0);
   for(const spy of spies)spy.mockClear();
   host.style.cssText='position:fixed;inset:0;width:800px;height:800px';view.setShown(true);
   await until('process resumes latest content and height',()=>{
    const viewport=host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    return !!viewport && viewport.getBoundingClientRect().height>0 && host.textContent?.includes('version 8')===true;
   });
   expect(spies.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBeGreaterThan(0);
  }else expect(measured).toBeGreaterThan(0);
 }finally{vi.restoreAllMocks();view.dispose();state.dispose();context.dispose();host.remove();}
},20000);
