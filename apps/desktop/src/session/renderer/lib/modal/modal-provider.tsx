import { runInAction } from 'mobx';
import { useObserver } from 'mobx-react-lite';
import { useCallback, type ReactNode } from 'react';
import { type modalRegistry } from '@renderer/app/modal-registry';
import { modalStore } from './modal-store';

export interface BaseModalProps<TResult = unknown> {
  onSuccess: (result: TResult) => void;
  onClose: () => void;
}

type UserArgs<MId extends ModalId> = Omit<ModalArgs<MId>, 'onSuccess' | 'onClose'> & {
  onSuccess?: (
    result: ModalArgs<MId> extends { onSuccess: (result: infer R) => void } ? R : unknown
  ) => void;
  onClose?: () => void;
};

export type ModalComponent<TProps = unknown, TResult = unknown> = (
  props: TProps & BaseModalProps<TResult>
) => ReactNode | Promise<ReactNode>;

type ModalId = keyof typeof modalRegistry;

type ModalArgs<TId extends ModalId> = Parameters<(typeof modalRegistry)[TId]['component']>[0];

// oxlint-disable-next-line typescript/no-explicit-any
export function wrapArgs<TId extends ModalId>(args: UserArgs<TId>): Record<string, any> {
  return {
    ...args,
    // oxlint-disable-next-line typescript/no-explicit-any
    onSuccess: (result: any) => {
      modalStore.closeModal('completed');
      args.onSuccess?.(result);
    },
    onClose: () => {
      modalStore.closeModal('dismissed');
      args.onClose?.();
    },
    // 有的弹窗另有一个收尾动作(确认框的取消键另有说法,如「只关会话」):它也要先把弹窗收起,
    // ❌ 只回调调用方 —— 那样遮罩一直挡在界面上,什么都点不了(#7097 实测)。
    ...('onCancel' in args && typeof args.onCancel === 'function'
      ? {
          onCancel: () => {
            modalStore.closeModal('dismissed');
            (args.onCancel as () => void)();
          },
        }
      : {}),
  };
}

export function useModalContext() {
  const showModal = useCallback(<TId extends ModalId>(id: TId, args: UserArgs<TId>) => {
    modalStore.setModal(id, wrapArgs(args));
  }, []);

  const transitionModal = useCallback(<TId extends ModalId>(id: TId, args: UserArgs<TId>) => {
    modalStore.setModal(id, wrapArgs(args));
    // No overlay event — the dialog stays open; AnimatedHeight handles the content swap.
  }, []);

  const closeModal = useCallback(() => modalStore.closeModal('dismissed'), []);

  const setCloseGuard = useCallback((active: boolean) => {
    runInAction(() => {
      modalStore.closeGuardActive = active;
    });
  }, []);

  const hasActiveCloseGuard = useObserver(() => modalStore.closeGuardActive);

  return { closeModal, showModal, transitionModal, hasActiveCloseGuard, setCloseGuard };
}

export function useShowModal<MId extends ModalId>(id: MId) {
  return useCallback(
    (args: UserArgs<MId>) => {
      modalStore.setModal(id, wrapArgs(args));
    },
    [id]
  );
}

export function useTransitionModal<MId extends ModalId>(id: MId) {
  return useCallback(
    (args: UserArgs<MId>) => {
      modalStore.setModal(id, wrapArgs(args));
    },
    [id]
  );
}

/**
 * Standalone (non-hook) alternative to useShowModal.
 * Safe to call from MobX reactions, command providers, and any code outside
 * of the React tree.
 */
export function showModal<TId extends ModalId>(id: TId, args: UserArgs<TId>): void {
  modalStore.setModal(id, wrapArgs(args));
}
