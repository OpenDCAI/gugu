import { describe, expect, it } from 'vitest';
import { isSendableText, modifierBits, parseCloudBrowserClientMessage, parseCloudBrowserServerMessage } from './cloud-browser';

/** #7199 云浏览器的线上消息:服务端只认格式对的;桌面只认得已知类型。 */
describe('#7199 cloud browser wire', () => {
  it('客户端消息:字段齐全才放行', () => {
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'config', framesEnabled: true, maxFps: 10, maxWidth: 1280, maxHeight: 800, tabId: null }))).toMatchObject({ type: 'config', maxFps: 10 });
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'config', framesEnabled: true, maxFps: 999, maxWidth: 1280, maxHeight: 800, tabId: null }))).toBeNull();
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }))).toMatchObject({ x: 1, y: 2 });
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'input_mouse', eventType: 'drag', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }))).toBeNull();
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'input_mouse', eventType: 'mouseWheel', x: 1, y: 2, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, deltaY: 1e9 }))).toMatchObject({ deltaY: 1e5 });
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'input_text', id: 't1', text: 'a\0b' }))).toBeNull();
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'vault_submit', requestId: 'r1', username: '', password: '', save: false }))).toBeNull();
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'vault_submit', requestId: 'r1', username: 'a', password: 'b', save: true }))).toBeNull();
    expect(parseCloudBrowserClientMessage(JSON.stringify({ type: 'rm_rf' }))).toBeNull();
    expect(parseCloudBrowserClientMessage('not json')).toBeNull();
  });

  it('服务端消息:不认得的类型丢掉(新版服务端多发的)', () => {
    expect(parseCloudBrowserServerMessage(JSON.stringify({ type: 'frame', seq: 1, tabId: 'T1', data: 'x', width: 10, height: 10, viewportWidth: 100, viewportHeight: 100 }))).toMatchObject({ type: 'frame' });
    expect(parseCloudBrowserServerMessage(JSON.stringify({ type: 'frame', seq: -1, tabId: 'T1', data: 'x', width: 10, height: 10, viewportWidth: 100, viewportHeight: 100 }))).toBeNull();
    expect(parseCloudBrowserServerMessage(JSON.stringify({ type: 'future_thing' }))).toBeNull();
  });

  it('不能交给网页的文字:\\0、落单的代理项', () => {
    expect(isSendableText('你好 😀')).toBe(true);
    expect(isSendableText('a\0')).toBe(false);
    expect(isSendableText('\ud83d')).toBe(false);
    expect(isSendableText('\ude00x')).toBe(false);
  });

  it('修饰键位与 CDP 一致:alt=1 ctrl=2 meta=4 shift=8', () => {
    expect(modifierBits({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13);
  });
});
