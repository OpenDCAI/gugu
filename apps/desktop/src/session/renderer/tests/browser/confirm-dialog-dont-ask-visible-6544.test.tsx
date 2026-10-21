/**
 * #6544 确认框里的「不再询问」必须整个看得见。
 *
 * 英文界面下,xs 确认框(320px)页脚一行塞不下「复选框 + Cancel + 带键帽的确认钮」;页脚 justify-end,
 * 溢出的那段挤向**左边**,再被弹窗的 overflow-hidden 裁掉 —— 裁掉的正是复选框,只剩「n't ask again」。
 * label 包着复选框,点那几个字就勾上一个看不见的「不再询问」,`interface.confirmBeforeArchive` 被静默
 * 写成 false:从此归档不再确认,「连同子会话一起归档」的勾选也跟着再没机会出现。
 *
 * 真 Chromium、真 CSS、真组件:要判的是排版算出来的位置,只有真引擎给得出。弹窗宽度照 modal-registry
 * 里 `confirmActionModal` 的 `size: 'xs'`(modal-renderer 的 `sm:max-w-xs`)。两个调用方(归档、
 * 回合中直接发送)× 中英两种语言;中文那两格本来就放得下,是这条判据的阴性对照。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import { ConfirmActionDialog } from '@renderer/lib/components/confirm-action-dialog';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
// 主题层与真实入口同一套(见 composer-model-menu-3249):字体、间距、键帽都从这里来,宽度才是真的。
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

// 确认钮上的快捷键键帽来自设置里的 keyboard 覆盖;不给覆盖 = 出厂的 Mod+Enter,和新装的用户一样。
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let previousLanguage = 'en-US';

beforeEach(async () => {
  previousLanguage = i18n.language;
  // 宽于 sm 断点(640px),`sm:max-w-xs` 与页脚的 `sm:flex-row` 才生效 —— 与桌面窗口同一档。
  await page.viewport(1100, 700);
  // 弹窗 portal 到 body,主题类要挂在 body 上它才取得到语义色与字体。
  document.body.classList.add('emlight', 'gugu-skin');
});

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.body.classList.remove('emlight', 'gugu-skin');
  await i18n.changeLanguage(previousLanguage);
});

type Cell = {
  confirmLabelKey: 'task.archiveTaskConfirm' | 'chat.cancelAndSend';
  dontAskAgainKey: 'task.archiveDontAskAgain' | 'chat.cancelAndSendDontAskAgain';
  variant: 'default' | 'destructive';
  scopeLabelKey?: 'task.archiveSessionWithChildrenOne';
};

const ARCHIVE: Cell = {
  confirmLabelKey: 'task.archiveTaskConfirm',
  dontAskAgainKey: 'task.archiveDontAskAgain',
  variant: 'default',
};
const ARCHIVE_WITH_CHILD: Cell = { ...ARCHIVE, scopeLabelKey: 'task.archiveSessionWithChildrenOne' };
const SEND_NOW: Cell = {
  confirmLabelKey: 'chat.cancelAndSend',
  dontAskAgainKey: 'chat.cancelAndSendDontAskAgain',
  variant: 'destructive',
};

async function mountDialog(locale: 'en-US' | 'zh-CN', cell: Cell) {
  await i18n.changeLanguage(locale);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <SessionLocalizationProvider>
      <Dialog open>
        <DialogContent className="sm:max-w-xs">
          <ConfirmActionDialog
            title={translateSessionMessage('task.archiveTaskTitle')}
            description={translateSessionMessage('task.archiveSessionDescription')}
            confirmLabel={translateSessionMessage(cell.confirmLabelKey)}
            variant={cell.variant}
            dontAskAgainLabel={translateSessionMessage(cell.dontAskAgainKey)}
            scopeLabel={cell.scopeLabelKey ? translateSessionMessage(cell.scopeLabelKey) : undefined}
            onSuccess={() => undefined}
            onClose={() => undefined}
          />
        </DialogContent>
      </Dialog>
    </SessionLocalizationProvider>
  );
  // 弹窗 portal 到 body,挂上来要等 React 提交:等页脚出现(页脚与里面的复选框、按钮同一次提交)。
  const dialogContent = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  await until('dialog footer mounted', () => dialogContent()?.querySelector('[data-slot="dialog-footer"]') != null);
  const dialog = dialogContent();
  // 弹窗开场有 zoom-in 动画;等它放完再量(包含关系不受缩放影响,只是省得读到半途的帧)。
  await Promise.all(dialog!.getAnimations({ subtree: true }).map((animation) => animation.finished));
  const footer = dialog?.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
  const dontAsk = [...(footer?.querySelectorAll<HTMLElement>('label') ?? [])].find((label) =>
    label.textContent?.includes(translateSessionMessage(cell.dontAskAgainKey))
  );
  const checkbox = dontAsk?.querySelector<HTMLElement>('[data-slot="checkbox"]');
  const buttons = [...(footer?.querySelectorAll<HTMLElement>('[data-slot="button"]') ?? [])];
  return { dialog, footer, dontAsk, checkbox, buttons };
}

/** 整个落在弹窗可见区之内(弹窗 overflow-hidden:出了这个框就被裁掉)。 */
function expectInside(inner: HTMLElement, outer: HTMLElement, what: string) {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  const where = `${what}: [${a.left.toFixed(1)}, ${a.right.toFixed(1)}] vs dialog [${b.left.toFixed(1)}, ${b.right.toFixed(1)}]`;
  expect(a.width, `${what} has no width`).toBeGreaterThan(0);
  expect(a.left, where).toBeGreaterThanOrEqual(b.left - 0.5);
  expect(a.right, where).toBeLessThanOrEqual(b.right + 0.5);
}

const CELLS: Array<[string, 'en-US' | 'zh-CN', Cell]> = [
  ['archive, English', 'en-US', ARCHIVE],
  ['archive with a child session, English', 'en-US', ARCHIVE_WITH_CHILD],
  ['send now mid-turn, English', 'en-US', SEND_NOW],
  ['archive, Chinese', 'zh-CN', ARCHIVE],
  ['send now mid-turn, Chinese', 'zh-CN', SEND_NOW],
];

it.each(CELLS)('%s: the whole "don\'t ask again" checkbox stays inside the dialog', async (_name, locale, cell) => {
  const { dialog, footer, dontAsk, checkbox, buttons } = await mountDialog(locale, cell);
  expect(dialog, 'dialog mounted').toBeTruthy();
  expect(footer, 'footer mounted').toBeTruthy();
  expect(dontAsk, 'dont-ask-again label rendered').toBeTruthy();
  expect(checkbox, 'dont-ask-again checkbox rendered').toBeTruthy();
  expect(buttons).toHaveLength(2);

  expectInside(checkbox!, dialog!, 'checkbox');
  expectInside(dontAsk!, dialog!, 'label');
  for (const button of buttons) expectInside(button, dialog!, `button "${button.textContent}"`);
  // 页脚自己也不许横向溢出:溢出就一定有东西被裁,只是这次裁到的不一定是复选框。
  expect(footer!.scrollWidth, 'footer overflows horizontally').toBeLessThanOrEqual(footer!.clientWidth + 1);
});
