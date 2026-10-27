import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({act:vi.fn(async()=>undefined),show:vi.fn(async()=>{})}));
vi.mock('./extensions-root',()=>({extensionsService:()=>({list:()=>({extensions:[]}),isEnabled:()=>true})}));
vi.mock('./extension-bridge',()=>({deliverToExtension:vi.fn()}));
vi.mock('@main/core/sessions/session-orchestration',()=>({revealExtensionTabInSession:vi.fn()}));
vi.mock('./extension-show-session',()=>({sessionHere:vi.fn(async()=>null),showSession:mocks.show}));
vi.mock('./extension-bridge-relay',()=>({actInWindow:mocks.act,listedSessionProject:vi.fn(async()=>null)}));
vi.mock('@main/core/host-locale',()=>({sessionHostLocale:()=> 'zh-CN'}));
vi.mock('@main/lib/events',()=>({events:{emit:vi.fn()}}));
import {openLink} from './gugu-links';
it('routes a desktop session link through account navigation before any device directory or attach',async()=>{
 const target={kind:'session' as const,sessionId:'prepared-task'};
 await expect(openLink(target)).resolves.toMatchObject({kind:'opened'});
 expect(mocks.act).toHaveBeenCalledWith({kind:'openLinkTarget',target});
 expect(mocks.show).not.toHaveBeenCalled();
});
