/** @jsxImportSource solid-js */
import { expect,it,vi } from 'vitest';
import {createChatContext} from '@session-chat/chat-context';
import {createChatView} from '@session-chat/chat-view';
import {createChatState} from '@session-chat/state/chat-state';
import {BLOCK_REGISTRY} from '@session-chat/components/rows/markdown/block-registry';
import {RETAINED_SURFACE_HIDDEN_STYLE} from '@/lib/retainedSurface';
import {until} from '../../../../tests/support/awaitCondition';
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
for(const hidden of [false,true]) it(`retained Markdown layout pauses hidden=${hidden}`,async()=>{
 const context=createChatContext({locale:()=> 'en-US'}),state=createChatState(context);
 const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;width:800px;height:600px';
 const view=createChatView({context,state,parent:host});
 const write=(v:number)=>state.transcript.activeTurn.set({id:'active',seq:0,initiator:'agent',items:[{kind:'message',id:'stream',seq:0,role:'assistant',text:`Changed markdown ${v} `+'paragraph '.repeat(v+2)}]},'generating');
 try{write(0);await until('real message mounts',()=>!!host.querySelector('[data-item-id="stream"]'));await frame();await frame();
  if(hidden){view.setShown(false);Object.assign(host.style,RETAINED_SURFACE_HIDDEN_STYLE);}await frame();await frame();
  const defs=[...new Set(Object.values(BLOCK_REGISTRY))],spies=defs.map(d=>vi.spyOn(d,'measure'));
  for(let n=1;n<=8;n++){write(n);await frame();await frame();}
  const measured=spies.reduce((n,s)=>n+s.mock.calls.length,0);console.info(JSON.stringify({hidden,blockMeasures:measured,childVisible:host.firstElementChild?.checkVisibility()}));
  if(hidden){
   expect(host.firstElementChild?.checkVisibility()).toBe(false);expect(measured).toBe(0);
   const row=host.querySelector('[data-item-id="stream"]');
   for(const spy of spies)spy.mockClear();
   host.style.cssText='position:fixed;inset:0;width:800px;height:600px';view.setShown(true);
   await until('Markdown resumes latest text and height',()=>{
    const current=host.querySelector<HTMLElement>('[data-item-id="stream"]');
    return !!current&&current.getBoundingClientRect().height>0&&host.textContent?.includes('Changed markdown 8')===true;
   });
   expect(host.querySelector('[data-item-id="stream"]')).toBe(row);
   expect(spies.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBeGreaterThan(0);
  }else expect(measured).toBeGreaterThan(0);
 }finally{vi.restoreAllMocks();view.dispose();state.dispose();context.dispose();host.remove();}
},20000);

it('defers first hidden leaf mount and resumes the latest model once shown', async () => {
 const context=createChatContext({locale:()=> 'en-US'}),state=createChatState(context);
 const host=document.body.appendChild(document.createElement('div'));
 host.style.cssText='position:fixed;inset:0;width:800px;height:600px';
 Object.assign(host.style,RETAINED_SURFACE_HIDDEN_STYLE);
 const view=createChatView({context,state,parent:host,shown:false});
 const spies=[...new Set(Object.values(BLOCK_REGISTRY))].map(def=>vi.spyOn(def,'measure'));
 try {
  for(let n=0;n<=8;n++) {
   state.transcript.activeTurn.set({id:'new-hidden',seq:0,initiator:'agent',items:[
    {kind:'message',id:'new-message',seq:0,role:'assistant',text:`New hidden model ${n}`} ]},'generating');
   await frame();
  }
  expect(spies.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBe(0);
  host.style.cssText='position:fixed;inset:0;width:800px;height:600px';
  view.setShown(true);
  await until('first visible leaf uses the latest hidden model',()=>{
   const row=host.querySelector<HTMLElement>('[data-item-id="new-message"]');
   return !!row&&row.getBoundingClientRect().height>0&&host.textContent?.includes('New hidden model 8')===true;
  });
  expect(spies.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBeGreaterThan(0);
 } finally {vi.restoreAllMocks();view.dispose();state.dispose();context.dispose();host.remove();}
},20000);
