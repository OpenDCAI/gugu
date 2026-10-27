import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import { observer } from 'mobx-react-lite';
import { events, rpc } from '@renderer/lib/ipc';
import { MotionPlayer, type Pt } from '@renderer/lib/vendor/cua-cursor-motion';
import { browserAgentCursorChannel } from '@shared/events/browserEvents';
import type { BrowserCursorInput } from '@shared/browser-cursor-input';
import { agentBrowserState } from './agent-browser-state';
import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility';

/** 每个页签上 agent 的鼠标最后停在哪。画布随 agent 停手消失,下次从这里接着飞。 */
const lastPoint = new Map<string, Pt>();

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 没有鼠标可飞(页签不在屏上、人看不见):记下落点、当场回「到了」—— 没人看着时 ❌ 让 agent 白等。 */
export function skipAgentCursorMove(event: { browserId: string; moveId: number; x: number; y: number }): void {
  lastPoint.set(event.browserId, { x: event.x, y: event.y });
  void rpc.browser.agentCursorArrived(event.moveId);
}

/**
 * #7191 agent 操作网页时它的鼠标:盖在网页上的一张透明画布,❌ 画进网页 —— 网页不变、agent 的截图里没有它、
 * 人自己的鼠标指针不被挪动。轨迹与画法用 cua 的 cursor-motion(lib/vendor)。
 *
 * 画布在窗口里叠在网页上面的那层里(agent-browser-overlay.tsx),那层铺满网页、点不穿:只在画鼠标时露出(告诉主进程),
 * 落在画布上的真实鼠标输入交给网页(它和画布一样大),点击、输入与滚动不改变 agent 的运行状态。
 *
 * 主进程每一下点击 / 悬停 / 滚动 / 打字前报一声 `move`,等这里回「到了」才把那一下交给网页(agent-browser.ts)。
 * 页签不在屏上(后台页签、会话页不在屏上)或 agent 没在操作就不播,当场回话 —— 没人看着时 ❌ 让 agent 白等。
 */
export const AgentBrowserCursor = observer(function AgentBrowserCursor({
  browserId,
  visible,
}: {
  browserId: string;
  visible: boolean;
}) {
  const shown = visible && agentBrowserState(browserId) === 'driving';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<MotionPlayer | null>(null);
  const [sized, setSized] = useState(false);

  const forward = (input: BrowserCursorInput) => void rpc.browser.forwardAgentCursorInput({ browserId, input });
  const modifiers = (event: MouseEvent) => {
    const result: NonNullable<BrowserCursorInput['modifiers']> = [];
    if (event.shiftKey) result.push('shift');
    if (event.ctrlKey) result.push('control');
    if (event.altKey) result.push('alt');
    if (event.metaKey) result.push('meta');
    if (event.buttons & 1) result.push('leftbuttondown');
    if (event.buttons & 2) result.push('rightbuttondown');
    if (event.buttons & 4) result.push('middlebuttondown');
    return result;
  };
  const mouse = (type: BrowserCursorInput['type'], event: MouseEvent<HTMLCanvasElement>) => forward({
    type, x: event.clientX, y: event.clientY,
    button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
    clickCount: event.detail, modifiers: modifiers(event),
  });
  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const scaleX = event.deltaMode === 2 ? event.currentTarget.clientWidth : event.deltaMode === 1 ? 16 : 1;
    const scaleY = event.deltaMode === 2 ? event.currentTarget.clientHeight : event.deltaMode === 1 ? 16 : 1;
    forward({ type: 'mouseWheel', x: event.clientX, y: event.clientY,
      deltaX: -event.deltaX * scaleX, deltaY: -event.deltaY * scaleY,
      hasPreciseScrollingDeltas: event.deltaMode === 0, canScroll: true, modifiers: modifiers(event) });
  };

  useEffect(() => {
    if (!shown) return;
    void rpc.browser.setAgentCursorShown({ browserId, shown: true });
    return () => void rpc.browser.setAgentCursorShown({ browserId, shown: false });
  }, [browserId, shown]);

  // 那层刚开、主进程还没把它摆到网页上时画布是 0×0:等它有了大小再起鼠标 —— ❌ 头一回从左上角飞出来。
  // 这之前 agent 的动作当场回「到了」、记下落点,鼠标起来时就落在那里。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !canvas) return;
    const observer = new ResizeObserver(() => setSized(canvas.clientWidth > 0 && canvas.clientHeight > 0));
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      setSized(false);
    };
  }, [shown]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !sized || !canvas) return;
    const stop = () => {
      const player = playerRef.current;
      if (!player) return;
      // A hidden decorative cursor must not leave an agent waiting for arrival.
      player.place(lastPoint.get(browserId) ?? player.pos);
      player.destroy();
      playerRef.current = null;
    };
    const stopViewport = observeAnimationViewport(canvas, (visible) => {
      if (!visible) { stop(); return; }
      if (playerRef.current) return;
      const player = new MotionPlayer(canvas);
      player.place(lastPoint.get(browserId) ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
      playerRef.current = player;
    });
    return () => { stopViewport(); stop(); };
  }, [browserId, shown, sized]);

  useEffect(
    () =>
      events.on(browserAgentCursorChannel, (event) => {
        if (event.browserId !== browserId) return;
        const player = playerRef.current;
        if (event.kind === 'click') {
          player?.click();
          return;
        }
        if (!player) {
          skipAgentCursorMove(event);
          return;
        }
        lastPoint.set(browserId, { x: event.x, y: event.y });
        void player
          .moveTo({ x: event.x, y: event.y }, { target: event.target, reducedMotion: reducedMotion() })
          .then(() => void rpc.browser.agentCursorArrived(event.moveId));
      }),
    [browserId]
  );

  if (!shown) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="agent-browser-cursor"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      onMouseDown={(event) => mouse('mouseDown', event)}
      onMouseUp={(event) => mouse('mouseUp', event)}
      onMouseMove={(event) => mouse('mouseMove', event)}
      onMouseEnter={(event) => mouse('mouseEnter', event)}
      onMouseLeave={(event) => mouse('mouseLeave', event)}
      onWheel={wheel}
    />
  );
});
