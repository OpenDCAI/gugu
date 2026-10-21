import {
  canOfferDontAskAgain,
  shouldConfirm,
  stopAsking,
} from '@renderer/features/settings/interface-confirm-preference';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/**
 * 排队提示的「立即发送」。这一下要取消在跑的回合(`cancelsTurn`)时先问,问不问由
 * `interface.confirmBeforeCancelAndSend` 说了算(出厂 = 问);不取消(空闲,或这家能插话,#6574)就直接发。
 * 确认框自带「不再询问」,设置 → 界面留一行把问题调回来 —— 与归档确认同一个形状(owner 2026-09-23)。
 */
export function requestSendQueuedPromptNow(args: { cancelsTurn: boolean; send: () => void }): void {
  const { cancelsTurn, send } = args;
  if (!cancelsTurn || !shouldConfirm('confirmBeforeCancelAndSend')) {
    send();
    return;
  }
  showModal('confirmActionModal', {
    title: translateSessionMessage('chat.turnInProgress'),
    description: translateSessionMessage('chat.cancelAndSendDescription'),
    confirmLabel: translateSessionMessage('chat.cancelAndSend'),
    variant: 'destructive',
    dontAskAgainLabel: canOfferDontAskAgain()
      ? translateSessionMessage('chat.cancelAndSendDontAskAgain')
      : undefined,
    onSuccess: ({ dontAskAgain }) => {
      if (dontAskAgain) {
        stopAsking('confirmBeforeCancelAndSend', {
          logTag: '[gugu-queue]',
          title: translateSessionMessage('chat.cancelAndSendDontAskAgainFailed'),
          description: translateSessionMessage('chat.cancelAndSendDontAskAgainFailedHint'),
        });
      }
      send();
    },
  });
}
