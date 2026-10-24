// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { wrapArgs } from './modal-provider';
import { modalStore } from './modal-store';

describe('弹窗的收尾动作都先把弹窗收起', () => {
  it('changing an open palette mode preserves the original return focus', () => {
    modalStore.closeModal();
    const task = document.createElement('textarea');
    const palette = document.createElement('input');
    document.body.append(task, palette);
    try {
      task.focus();
      modalStore.setModal('commandPaletteModal', { initialQuery: '' });
      palette.focus();
      modalStore.setModal('commandPaletteModal', { initialQuery: '> ' });
      expect(modalStore.previousFocus).toBe(task);
      expect(modalStore.activeModalArgs?.initialQuery).toBe('> ');
    } finally { modalStore.closeModal(); task.remove(); palette.remove(); }
  });
  it('取消键另有说法(onCancel,如「只关会话」):弹窗收起,调用方收到这一句;❌ 遮罩一直挡着', () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    const wrapped = wrapArgs({ title: 't', description: 'd', onCancel, onClose } as never);
    modalStore.setModal('confirmActionModal', wrapped);
    expect(modalStore.isOpen).toBe(true);

    (wrapped.onCancel as () => void)();
    expect(modalStore.isOpen).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('没给 onCancel 的弹窗不多出一个', () => {
    const wrapped = wrapArgs({ title: 't', description: 'd' } as never);
    expect('onCancel' in wrapped).toBe(false);
  });
});
