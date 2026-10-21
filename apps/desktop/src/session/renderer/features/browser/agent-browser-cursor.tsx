import { useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { events, rpc } from '@renderer/lib/ipc';
import { MotionPlayer, type Pt } from '@renderer/lib/vendor/cua-cursor-motion';
import { browserAgentCursorChannel } from '@shared/events/browserEvents';
import { agentBrowserState } from './agent-browser-state';

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
 * 人自己的鼠标不受影响。轨迹与画法用 cua 的 cursor-motion(lib/vendor)。
 *
 * 主进程每一下点击 / 悬停 / 滚动 / 打字前报一声 `move`,等这里回「到了」才把那一下交给网页(agent-browser.ts)。
 * 页签不在屏上(后台页签、会话页不在屏上)或人接管了就不播,当场回话 —— 没人看着时 ❌ 让 agent 白等。
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !canvas) return;
    const player = new MotionPlayer(canvas);
    player.place(lastPoint.get(browserId) ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
    playerRef.current = player;
    return () => {
      lastPoint.set(browserId, player.pos);
      player.destroy();
      playerRef.current = null;
    };
  }, [browserId, shown]);

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
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
});
