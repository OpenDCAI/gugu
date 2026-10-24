import type { ReactNode } from 'react';

export interface BaseModalProps<TResult = unknown> {
  onSuccess: (result: TResult) => void;
  onClose: () => void;
}
export type ModalComponent<TProps = unknown, TResult = unknown> = (props: TProps & BaseModalProps<TResult>) => ReactNode | Promise<ReactNode>;
export type ModalSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ModalPosition = 'center' | 'top';
export type ModalRegistryEntry<TProps = unknown, TResult = unknown> = {
  component: ModalComponent<TProps, TResult>;
  size?: ModalSize;
  position?: ModalPosition;
  ignoreOutsidePressAfterWindowBlur?: boolean;
};

export function createModal<TProps, TResult>(
  component: ModalComponent<TProps, TResult>,
  config: Omit<ModalRegistryEntry, 'component'> = {},
): ModalRegistryEntry<TProps, TResult> {
  return { component, ...config };
}
