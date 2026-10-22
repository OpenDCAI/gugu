import type { EventEmitter } from 'node:events';
import { dialog, type BrowserWindow, type MessageBoxOptions, type WebContents } from 'electron';
import { log } from '@main/lib/logger';

/**
 * #72 浏览器页签里网页弹的 JS 对话框(alert / confirm / prompt)。
 *
 * Electron 自己的处理(lib/browser/api/web-contents.ts 的 `-run-dialog`)一律挂到网页所在那扇窗上:网页停在停放窗里
 * (browser-page-views.ts)时,macOS 把那扇从不显示的窗连同对话框一起排上屏幕 —— 一块没有标题栏、关不掉的白窗;
 * agent 经 CDP 答掉对话框后,Electron 那个对话框也不关,停在屏上(mac1 实测)。⇒ 接管成一条规矩:
 *
 * - **对话框只出现在人正在看的页签上**,挂在那扇咕咕窗口上;网页不在屏上时什么窗都不出。谁先答算谁的,答完就关。
 * - **不在屏上、agent 没连着**:照 Chrome 对后台页签的做法(components/javascript_dialogs/tab_modal_dialog_manager.cc)——
 *   alert 当场放行、等页签露出来再给人看;confirm 当场取消。
 * - **agent 连着**:Chromium 把同一个对话框同时交给 DevTools 和 Electron,谁先答算谁的 ⇒ 交给 agent 经 CDP 答
 *   (Page.javascriptDialogOpening / handleJavaScriptDialog);网页在屏上时人也看得见、也能答。agent 先答了,人那边的随即关掉;
 *   agent 断开时还没答、网页又不在屏上 → 按上一条办。
 * - prompt:Electron 本来就不支持(当场取消),照旧。
 *
 * Electron 没有公开的对话框钩子,`-run-dialog` / `-cancel-dialogs` 是它的内部事件(v44)。认不出时(升级后改了)
 * 不接管、记一条警告,退回 Electron 默认。
 */

type DialogType = 'alert' | 'confirm' | 'prompt';
type DialogInfo = { dialogType: DialogType; messageText: string };
type DialogCallback = (success: boolean, userInput: string) => void;

type PageDialog = {
  type: DialogType;
  message: string;
  /** 还没回给网页的回调;已经回过(后台的 alert 当场放行)就是 null,只剩给人看。 */
  answer: DialogCallback | null;
  /** 正在人眼前的那个对话框。 */
  showing: AbortController | null;
};

export type PageDialogs = {
  /** 网页露到人眼前了:有攒着的对话框就挂到那扇窗上。 */
  pageShown(): void;
};

const RUN_DIALOG = '-run-dialog';
const CANCEL_DIALOGS = '-cancel-dialogs';
let warned = false;

export function wirePageDialogs(
  webContents: WebContents,
  page: { onScreen: () => boolean; host: () => BrowserWindow | null },
): PageDialogs {
  const emitter = webContents as unknown as EventEmitter;
  if (emitter.listenerCount(RUN_DIALOG) !== 1 || emitter.listenerCount(CANCEL_DIALOGS) !== 1) {
    if (!warned) log.warn('Browser page dialogs: Electron dialog internals not recognised, using Electron defaults');
    warned = true;
    return { pageShown() {} };
  }
  emitter.removeAllListeners(RUN_DIALOG);
  emitter.removeAllListeners(CANCEL_DIALOGS);

  let pending: PageDialog | null = null;

  const close = (current: PageDialog) => {
    current.showing?.abort();
    current.showing = null;
    if (pending === current) pending = null;
  };

  /** 回给网页(只回一次)。 */
  const reply = (current: PageDialog, success: boolean) => {
    const answer = current.answer;
    current.answer = null;
    answer?.(success, '');
  };

  /** 不在屏上、没人来答:alert 放行、留着等露出来给人看;confirm 取消。 */
  const answerInBackground = (current: PageDialog) => {
    reply(current, current.type === 'alert');
    if (current.type !== 'alert') close(current);
  };

  const show = (current: PageDialog) => {
    const host = page.host();
    if (current.showing || !host || host.isDestroyed()) return;
    const controller = new AbortController();
    current.showing = controller;
    const options: MessageBoxOptions = {
      message: current.message,
      signal: controller.signal,
      ...(current.type === 'confirm'
        ? { buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 }
        : { buttons: ['OK'], defaultId: -1, cancelId: 0 }),
    };
    dialog
      .showMessageBox(host, options)
      .then(({ response }) => {
        if (controller.signal.aborted || webContents.isDestroyed()) return;
        close(current);
        reply(current, response === 0);
      })
      .catch((error: unknown) => {
        log.warn('Browser page dialogs: could not show a dialog', { error: String(error) });
        close(current);
      });
  };

  emitter.on(RUN_DIALOG, (info: DialogInfo, callback: DialogCallback) => {
    if (info.dialogType === 'prompt') return callback(false, '');
    // 网页在等一个对话框时不会再弹下一个;顶替的只会是攒着给人看的后台 alert。保险起见没回过的先取消。
    if (pending) {
      reply(pending, false);
      close(pending);
    }
    const current: PageDialog = { type: info.dialogType, message: info.messageText, answer: callback, showing: null };
    pending = current;
    if (page.onScreen()) show(current);
    else if (!webContents.debugger.isAttached()) answerInBackground(current);
  });

  // 网页换页 / 关掉时 Chromium 取消它的对话框:人眼前那个关掉,攒着的不再给人看。
  emitter.on(CANCEL_DIALOGS, () => {
    if (pending) close(pending);
  });

  // 网页的对话框已经被别人(agent 经 CDP)答掉了:人那边的随即关掉。我们自己回过的(answer 为 null)不算。
  webContents.debugger.on('message', (_event, method) => {
    if (method === 'Page.javascriptDialogClosed' && pending?.answer) {
      pending.answer = null;
      close(pending);
    }
  });
  // agent 断开时还没答:网页不在屏上就按后台的规矩办;在屏上的,人照常能答。
  webContents.debugger.on('detach', () => {
    if (pending?.answer && !page.onScreen()) answerInBackground(pending);
  });

  return {
    pageShown() {
      if (pending && page.onScreen()) show(pending);
    },
  };
}
