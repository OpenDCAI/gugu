// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shieldNativeDrags } from './drag-shield';

const SESSION = 'application/x-gugu-session';

/** A drag event the way the browser hands it over: bubbling, with a dataTransfer that names what is dragged. */
function drag(type: 'dragstart' | 'dragend' | 'drop', types: string[] = [SESSION]): DragEvent {
  const event = new Event(type, { bubbles: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}
const shielded = () => document.documentElement.hasAttribute('data-gugu-dragging');

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-gugu-dragging');
});

describe('shieldNativeDrags', () => {
  const start = (onEnd = vi.fn()) => {
    stop = shieldNativeDrags(document, (dataTransfer) => dataTransfer.types.includes(SESSION), onEnd);
    const row = document.createElement('div');
    document.body.appendChild(row);
    return { row, onEnd };
  };

  it('opens on a session drag and closes when it ends', () => {
    const { row, onEnd } = start();
    row.dispatchEvent(drag('dragstart'));
    expect(shielded()).toBe(true);
    row.dispatchEvent(drag('dragend'));
    expect(shielded()).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });

  it('leaves other drags alone', () => {
    const { row } = start();
    row.dispatchEvent(drag('dragstart', ['Files']));
    expect(shielded()).toBe(false);
  });

  // 侧栏项目区是虚拟列表:拖到边上自动滚,源那一行被卸掉;dragend 打在脱离文档的节点上,冒不到 document。
  it('still closes when the row it was dragged from left the page mid-drag', () => {
    const { row, onEnd } = start();
    row.dispatchEvent(drag('dragstart'));
    row.remove();
    row.dispatchEvent(drag('dragend'));
    expect(shielded()).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });
});
