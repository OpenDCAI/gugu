import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wirePageDialogs } from './browser-page-dialogs';

/**
 * #72 网页弹的 JS 对话框只出现在人正在看的页签上:不在屏上什么窗都不出(❌ 挂到停放窗上把它排上屏幕),
 * 后台照 Chrome 办,agent 连着交给 agent 答、答了人那边随即关掉。
 */

const state = vi.hoisted(() => ({
  boxes: [] as Array<{ parent: unknown; options: any; resolve: (r: { response: number }) => void; reject: (e: Error) => void }>,
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (parent: unknown, options: any) =>
      new Promise<{ response: number }>((resolve, reject) => state.boxes.push({ parent, options, resolve, reject })),
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

/** 照 Electron v44 的 WebContents:自带 `-run-dialog` / `-cancel-dialogs` 两个内部监听,外加 debugger。 */
function fakeWebContents() {
  const electronDefault = vi.fn();
  const webContents = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    debugger: Object.assign(new EventEmitter(), { attached: false, isAttached(): boolean { return this.attached; } }),
  });
  webContents.on('-run-dialog', electronDefault);
  webContents.on('-cancel-dialogs', () => {});
  return { webContents, electronDefault };
}

const host = { isDestroyed: () => false };
let currentHost: unknown = host;
let shown = false;

function wire() {
  const fake = fakeWebContents();
  const dialogs = wirePageDialogs(fake.webContents as any, { onScreen: () => shown, host: () => currentHost as any });
  const run = (dialogType: string, messageText = 'hi') => {
    const callback = vi.fn();
    fake.webContents.emit('-run-dialog', { dialogType, messageText }, callback);
    return callback;
  };
  /** agent 开着 Page:Chromium 先把对话框经 CDP 报给它,再交给 Electron。 */
  const runForAgent = (dialogType: string, messageText = 'hi') => {
    fake.webContents.debugger.attached = true;
    fake.webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: dialogType, message: messageText });
    return run(dialogType, messageText);
  };
  return { ...fake, dialogs, run, runForAgent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.boxes.length = 0;
  shown = false;
  currentHost = host;
});

describe('#72 网页的 JS 对话框', () => {
  it('接管 Electron 默认的处理(它会挂到网页所在那扇窗上,停放窗也照挂)', () => {
    const { electronDefault, run } = wire();
    run('alert');
    expect(electronDefault).not.toHaveBeenCalled();
  });

  it('不在屏上、没有 agent:alert 当场放行、什么窗都不出;页签露出来再挂到那扇窗上给人看', async () => {
    const { dialogs, run } = wire();
    const callback = run('alert', 'saved');
    expect(callback).toHaveBeenCalledWith(true, '');
    expect(state.boxes).toHaveLength(0);
    shown = true;
    dialogs.pageShown();
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: host, options: { message: 'saved', buttons: ['OK'] } });
    state.boxes[0].resolve({ response: 0 });
    await flush();
    expect(callback).toHaveBeenCalledOnce();
    dialogs.pageShown();
    expect(state.boxes).toHaveLength(1);
  });

  it('不在屏上、没有 agent:confirm 当场取消,之后也不给人看;prompt 照 Electron 取消', () => {
    const { dialogs, run } = wire();
    expect(run('confirm')).toHaveBeenCalledWith(false, '');
    expect(run('prompt')).toHaveBeenCalledWith(false, '');
    shown = true;
    dialogs.pageShown();
    expect(state.boxes).toHaveLength(0);
  });

  it('在屏上:挂到那扇窗上,人答了才回给网页', async () => {
    shown = true;
    const { run } = wire();
    const callback = run('confirm', 'delete?');
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: host, options: { message: 'delete?', buttons: ['OK', 'Cancel'], cancelId: 1 } });
    expect(callback).not.toHaveBeenCalled();
    state.boxes[0].resolve({ response: 1 });
    await flush();
    expect(callback).toHaveBeenCalledWith(false, '');
  });

  it('agent 经 CDP 收到了、不在屏上:不出窗也不替它答,留给 agent 答', () => {
    const { runForAgent } = wire();
    const callback = runForAgent('confirm');
    expect(callback).not.toHaveBeenCalled();
    expect(state.boxes).toHaveLength(0);
  });

  it('调试器连着但 agent 没收到(没开 Page):按后台的规矩办,❌ 让网页卡着', () => {
    const { webContents, run } = wire();
    webContents.debugger.attached = true;
    expect(run('confirm')).toHaveBeenCalledWith(false, '');
  });

  it('beforeunload 的通知不算:下一个对话框照后台的规矩办', () => {
    const { webContents, run } = wire();
    webContents.debugger.attached = true;
    webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'beforeunload' });
    expect(run('confirm')).toHaveBeenCalledWith(false, '');
  });

  it('agent 收到了、在屏上:人也看得见;agent 先答了,人那边的随即关掉、不再回给网页', async () => {
    shown = true;
    const { webContents, runForAgent } = wire();
    const callback = runForAgent('confirm');
    const box = state.boxes[0];
    expect(box.options.signal.aborted).toBe(false);
    webContents.debugger.emit('message', {}, 'Page.javascriptDialogClosed', { result: true });
    expect(box.options.signal.aborted).toBe(true);
    box.resolve({ response: 0 });
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });

  it('agent 没答就断开:不在屏上按后台的规矩办', () => {
    const { webContents, runForAgent } = wire();
    const confirm = runForAgent('confirm');
    webContents.debugger.attached = false;
    webContents.debugger.emit('detach', {}, 'target closed');
    expect(confirm).toHaveBeenCalledWith(false, '');
  });

  it('agent 没答、人把页签切出来了:挂到那扇窗上让人答', async () => {
    const { dialogs, runForAgent } = wire();
    const callback = runForAgent('confirm');
    shown = true;
    dialogs.pageShown();
    expect(state.boxes).toHaveLength(1);
    state.boxes[0].resolve({ response: 0 });
    await flush();
    expect(callback).toHaveBeenCalledWith(true, '');
  });

  it('网页换页 / 关掉(Chromium 取消对话框):人眼前那个关掉,攒着的不再给人看', () => {
    shown = true;
    const { webContents, run } = wire();
    run('alert');
    webContents.emit('-cancel-dialogs', { resetState: false });
    expect(state.boxes[0].options.signal.aborted).toBe(true);
  });

  it('对话框弹不出来(出错):当作取消回给网页,❌ 让网页卡着', async () => {
    shown = true;
    const { run } = wire();
    const callback = run('confirm');
    state.boxes[0].reject(new Error('no window'));
    await flush();
    expect(callback).toHaveBeenCalledWith(false, '');
  });

  it('网页换了窗:旧窗上的收回来,在屏上就挂到新窗上', () => {
    shown = true;
    const { dialogs, run } = wire();
    const callback = run('confirm');
    const old = state.boxes[0];
    const next = { isDestroyed: () => false };
    currentHost = next;
    dialogs.hostChanged();
    expect(old.options.signal.aborted).toBe(true);
    expect(state.boxes[1]).toMatchObject({ parent: next });
    expect(callback).not.toHaveBeenCalled();
  });

  it('那扇窗关了、网页不在屏上:旧窗上的收回来,按后台的规矩办', () => {
    shown = true;
    const { dialogs, run } = wire();
    const callback = run('confirm');
    shown = false;
    currentHost = null;
    dialogs.hostChanged();
    expect(state.boxes[0].options.signal.aborted).toBe(true);
    expect(callback).toHaveBeenCalledWith(false, '');
  });

  it('认不出 Electron 的内部事件(升级改了):不接管,退回 Electron 默认', () => {
    const webContents = Object.assign(new EventEmitter(), { debugger: new EventEmitter() });
    const own = vi.fn();
    webContents.on('-run-dialog', own);
    wirePageDialogs(webContents as any, { onScreen: () => false, host: () => null });
    webContents.emit('-run-dialog', { dialogType: 'alert', messageText: '' }, vi.fn());
    expect(own).toHaveBeenCalledOnce();
  });
});
