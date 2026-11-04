// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../support/testHarness';
import { HtmlPreviewSurface } from '@/components/preview/HtmlPreviewSurface';
let h:ReturnType<typeof createReactHarness>;
beforeEach(()=>{ h=createReactHarness();vi.useFakeTimers(); });
afterEach(()=>{ h.cleanup();vi.useRealTimers(); });
for(const changeCallback of [false,true]) it(`review: a loaded CSP-blocked replacement still appears after a parent rerender (new callback=${changeCallback})`,async()=>{
 const onLink=vi.fn();
 await h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url:'blob:first',onLink}));
 await h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url:'blob:second',onLink}));
 const pending=h.container.querySelectorAll('iframe')[1]!;
 await act(async()=>pending.dispatchEvent(new Event('load')));
 await act(async()=>{ await vi.advanceTimersByTimeAsync(200); });
 await h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url:'blob:second',onLink:changeCallback?vi.fn():onLink}));
 await act(async()=>{ await vi.advanceTimersByTimeAsync(10000); });
 const visible=h.container.querySelector('iframe.visible')!;
 expect(visible.getAttribute('src'),'after load the CSP fallback must survive a callback-only rerender').toBe('blob:second');
 expect(h.container.querySelectorAll('iframe')).toHaveLength(1);
});
it('review: forged/old-frame restoration and hidden links cannot switch the visible page',async()=>{
 const onLink=vi.fn();
 await h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url:'blob:first',onLink}));
 const first=h.container.querySelector('iframe')!;
 await h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url:'blob:second',onLink}));
 const pending=h.container.querySelectorAll('iframe')[1]!;
 const send=(source:MessageEventSource|null,data:unknown)=>act(async()=>{window.dispatchEvent(new MessageEvent('message',{source,data}));});
 await send(window,{type:'gugu-preview-restored'});
 await send(first.contentWindow,{type:'gugu-preview-restored'});
 await send(pending.contentWindow,{type:'gugu-preview-link',href:'https://hidden.test'});
 expect(h.container.querySelector('iframe.visible')).toBe(first);
 expect(onLink).not.toHaveBeenCalled();
 expect(pending.getAttribute('sandbox')).toBe('allow-scripts');
 await send(pending.contentWindow,{type:'gugu-preview-restored'});
 expect(h.container.querySelector('iframe.visible')).toBe(pending);
});

it('waits for the new frame to load when a previous replacement URL is revisited', async () => {
 const onLink=vi.fn();
 const draw=(url:string)=>h.render(createElement(HtmlPreviewSurface,{fileName:'page.html',url,onLink}));
 await draw('blob:first'); await draw('blob:second');
 await act(async()=>h.container.querySelectorAll('iframe')[1]!.dispatchEvent(new Event('load')));
 await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
 await draw('blob:third'); await draw('blob:second');
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(h.container.querySelector('iframe.visible')?.getAttribute('src')).toBe('blob:first');
 await act(async()=>h.container.querySelectorAll('iframe')[1]!.dispatchEvent(new Event('load')));
 await act(async()=>{await vi.advanceTimersByTimeAsync(501);});
 expect(h.container.querySelector('iframe.visible')?.getAttribute('src')).toBe('blob:second');
});
