/** @jsxImportSource solid-js */
import {it,expect} from 'vitest';
import {createChatContext} from '../chat-context';
import {createChatState} from '../state/chat-state';
import {createChatView} from '../chat-view';
import {until} from '../../../../tests/support/awaitCondition';
import '../styles/global.css';

it('paints a temporary source highlight without depending on a host stylesheet', async () => {
  const context=createChatContext({ locale: () => 'en-US' });
  const state=createChatState(context);
  state.transcript.history.seed([{id:'turn',seq:0,initiator:'user',items:[{kind:'message',id:'source',seq:0,role:'user',text:'Original message'}]}]);
  const host=document.createElement('div');host.style.cssText='width:600px;height:500px';document.body.append(host);
  const view=createChatView({context,state,parent:host,commands:{flashMessageId:'source'}});
  try {
    await until('the highlighted source is rendered',()=>!!host.querySelector('.msg-src-flash'));
    const row=host.querySelector<HTMLElement>('.msg-src-flash')!;
    expect(row.getAnimations()).toHaveLength(1);
    const animation=row.getAnimations()[0]!;animation.pause();animation.currentTime=100;
    expect(animation.effect!.getTiming().duration).toBe(1400);
    expect(getComputedStyle(row).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    view.setCommands({flashMessageId:null});
    await until('the temporary highlight is removed',()=>!host.querySelector('.msg-src-flash'));
    expect(row.getAnimations()).toHaveLength(0);
  } finally {view.dispose();host.remove()}
});
