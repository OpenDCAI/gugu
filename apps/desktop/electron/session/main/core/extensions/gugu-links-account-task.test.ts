import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({act:vi.fn(async():Promise<unknown>=>'own'),show:vi.fn(async()=>{}),here:vi.fn(async():Promise<string|null>=>null),bringUp:vi.fn(async()=>{})}));
vi.mock('./extensions-root',()=>({extensionsService:()=>({list:()=>({extensions:[]}),isEnabled:()=>true})}));
vi.mock('./extension-bridge',()=>({deliverToExtension:vi.fn(),bringSessionUp:mocks.bringUp}));
vi.mock('@main/core/sessions/session-orchestration',()=>({revealExtensionTabInSession:vi.fn()}));
vi.mock('./extension-show-session',()=>({sessionHere:mocks.here,showSession:mocks.show}));
vi.mock('./extension-bridge-relay',()=>({actInWindow:mocks.act,listedSessionProject:vi.fn(async()=>null)}));
vi.mock('@main/core/host-locale',()=>({sessionHostLocale:()=> 'zh-CN'}));
vi.mock('@main/lib/events',()=>({events:{emit:vi.fn()}}));
import {openLink} from './gugu-links';
it('routes a desktop session link through account navigation before any device directory or attach',async()=>{
 const target={kind:'session' as const,sessionId:'prepared-task'};
 await expect(openLink(target)).resolves.toMatchObject({kind:'opened'});
 expect(mocks.act).toHaveBeenCalledWith({kind:'openLinkTarget',target});
 expect(mocks.here).not.toHaveBeenCalled();
 expect(mocks.bringUp).not.toHaveBeenCalled();
});
it('a session the account shell does not open comes up as gugu.showSession finds it: this computer first',async()=>{
 // Control (the parent commit 2dae2795): the window's phone-only directory was the end of it ⇒ 「not in your task list」.
 mocks.act.mockResolvedValueOnce(undefined);
 mocks.here.mockResolvedValueOnce('project-here');
 await expect(openLink('gugu://session/on-this-computer')).resolves.toMatchObject({kind:'opened'});
 expect(mocks.bringUp).toHaveBeenCalledWith({projectId:'project-here',sessionId:'on-this-computer'});
});
